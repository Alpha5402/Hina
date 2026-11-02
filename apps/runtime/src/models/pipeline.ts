import type {
  Decision,
  EventContext,
  Model,
  ModelMessage,
  ModelResponse,
  RuntimeEvent,
  RuntimeHooks,
} from "@hina/core";
import { parseDecisionResult } from "@hina/core";
import type { DecisionTrace, MessageProcessing } from "@hina/logs";
import { conversationKey, eventKey } from "../context";
import { fetchImage } from "../logs/images";
import type { MessageLogStore } from "../logs/store";
import { ServiceError } from "../settings/errors";
import type { EncryptedSettingsStore, LlmConfiguration } from "../settings/store";
import { OpenAICompatibleModel } from "./openai-compatible";
import { OpenAIDecision } from "./openai-decision";

interface Turn {
  readonly config: LlmConfiguration;
  readonly controller: AbortController;
  decision: DecisionTrace;
  stage: "decision" | "model";
  response?: ModelResponse;
}
interface PipelineOptions {
  readonly model?: (config: LlmConfiguration) => Model;
  readonly decision?: (config: LlmConfiguration) => Decision;
  readonly image?: typeof fetchImage;
  readonly now?: () => number;
}

function text(event: RuntimeEvent): string {
  return event.origin.channelId === "qq" && event.content.type === "message"
    ? event.content.text.replace(/<faceType=\d+,faceId="[^"]*",ext="[^"]*">/g, "").trim()
    : event.content.text;
}

export class ModelPipeline {
  private readonly turns = new Map<string, Turn>();
  private readonly shared = new Map<string, number>();
  private readonly replies = new Map<string, string>();
  private readonly calls: number[] = [];
  private readonly unsubscribe: () => void;
  private readonly now: () => number;
  readonly hooks: RuntimeHooks;

  constructor(
    private readonly settings: EncryptedSettingsStore,
    private readonly logs: MessageLogStore,
    private readonly appId: string,
    private readonly options: PipelineOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.unsubscribe = settings.subscribe(() => {
      for (const turn of this.turns.values()) turn.controller.abort();
      this.shared.clear();
      this.replies.clear();
    });
    this.hooks = {
      beforeHandle: (context) => this.gate(context),
      handle: (context) => this.generate(context),
      beforeSend: ({ event, action }) => {
        const turn = this.turns.get(eventKey(event));
        if (!turn?.response) return "deny";
        if (
          this.settings.current()?.revision !== turn.config.revision ||
          !this.settings.current()?.enabled ||
          (turn.config.decisionModel &&
            (turn.decision.status !== "evaluated" || !turn.decision.passed)) ||
          turn.controller.signal.aborted ||
          action.target.channelId !== "qq" ||
          action.target.accountId !== this.appId ||
          action.target.conversationId !== event.conversationId ||
          action.content.text !== turn.response.text
        ) {
          this.record(event, { status: "blocked", response: turn.response });
          this.finish(event);
          return "deny";
        }
        this.record(event, { status: "sending", response: turn.response });
        return "allow";
      },
      afterSend: ({ event }) => {
        const turn = this.turns.get(eventKey(event));
        try {
          if (turn?.response) {
            this.record(event, {
              status: "sent",
              response: turn.response,
              sentAt: new Date(this.now()).toISOString(),
            });
            if (this.settings.current()?.revision === turn.config.revision)
              this.replies.set(eventKey(event), turn.response.text);
          }
        } finally {
          this.finish(event);
        }
      },
      onError: ({ event, stage, error, sentCount }) => {
        const turn = this.turns.get(eventKey(event));
        try {
          if (sentCount > 0 && turn?.response)
            this.record(event, {
              status: "sent",
              response: turn.response,
              sentAt: new Date(this.now()).toISOString(),
            });
          else
            this.record(event, {
              status: "failed",
              stage:
                stage === "send" || stage === "afterSend"
                  ? "send"
                  : stage === "beforeSend"
                    ? "policy"
                    : (turn?.stage ?? "model"),
              code:
                stage === "send"
                  ? "delivery_unconfirmed"
                  : error instanceof ServiceError
                    ? error.code
                    : "processing_failed",
              ...(turn?.response ? { response: turn.response } : {}),
            });
        } finally {
          this.finish(event);
        }
      },
    };
  }

  private gate({ event }: EventContext): "continue" | "observe" {
    const config = this.settings.current();
    let reason: Extract<MessageProcessing, { status: "skipped" }>["reason"] | undefined;
    if (!config)
      reason = this.settings.unavailable ? "configuration-unavailable" : "not-configured";
    else if (!config.enabled) reason = "disabled";
    else if (
      event.origin.channelId !== "qq" ||
      event.origin.accountId !== this.appId ||
      !(
        event.conversationType === "direct" ||
        (config.replyScope === "direct-and-groups" && event.conversationType === "group")
      )
    )
      reason = "scope";
    else if (event.content.type === "message" && !config.includeImages && !text(event).trim())
      reason = "images-disabled";
    else if (
      event.content.type === "message" &&
      config.includeImages &&
      event.content.images.length > 2
    )
      reason = "image-limit";
    else if (text(event).length > 12_000) reason = "input-limit";
    const now = this.now();
    while (this.calls[0] !== undefined && now - this.calls[0] >= 60_000) this.calls.shift();
    if (!reason && (this.turns.size >= 2 || this.calls.length >= 30)) reason = "budget";
    if (reason || !config) {
      this.logs.recordProcessing(event, { status: "skipped", reason: reason ?? "not-configured" });
      return "observe";
    }
    for (const [key, timestamp] of this.shared)
      if (now - timestamp >= 300_000) {
        this.shared.delete(key);
        this.replies.delete(key);
      }
    if (this.shared.size >= 1000) {
      const oldest = this.shared.keys().next().value;
      if (oldest !== undefined) {
        this.shared.delete(oldest);
        this.replies.delete(oldest);
      }
    }
    this.calls.push(now);
    this.shared.set(eventKey(event), now);
    this.turns.set(eventKey(event), {
      config,
      controller: new AbortController(),
      stage: config.decisionModel ? "decision" : "model",
      decision: config.decisionModel
        ? { status: "evaluating", model: config.decisionModel, threshold: config.decisionThreshold }
        : { status: "skipped", reason: "not-configured" },
    });
    this.record(event, {
      status: config.decisionModel ? "deciding" : "generating",
      startedAt: new Date(now).toISOString(),
    });
    return "continue";
  }

  private async generate(context: EventContext) {
    const turn = this.turns.get(eventKey(context.event));
    if (!turn) return [];
    const signal = AbortSignal.any([context.signal, turn.controller.signal]);
    const history: ModelMessage[] = [];
    let remaining = 12_000;
    const eligible = context.history.filter(
      (event) =>
        this.shared.has(eventKey(event)) &&
        conversationKey(event) === conversationKey(context.event),
    );
    for (const event of [...eligible].reverse()) {
      const reply = this.replies.get(eventKey(event));
      const value = text(event).slice(-remaining);
      const current: ModelMessage = { role: "user", text: value || "[图片消息]" };
      if (
        eventKey(event) === eventKey(context.event) &&
        turn.config.includeImages &&
        event.content.type === "message"
      ) {
        const images = await Promise.all(
          event.content.images.map(async (image) => {
            const result = await (this.options.image ?? fetchImage)(image.url, signal);
            return {
              mediaType: result.mediaType,
              base64: Buffer.from(result.bytes).toString("base64"),
            };
          }),
        );
        history.unshift({ ...current, images });
      } else if (reply && remaining > value.length + reply.length) {
        history.unshift(current, { role: "assistant", text: reply });
        remaining -= reply.length;
      } else history.unshift(current);
      remaining -= value.length;
      if (remaining <= 0) break;
    }
    if (context.event.content.type === "message" && !turn.config.includeImages && history.length) {
      const last = history[history.length - 1];
      if (last?.role === "user")
        history[history.length - 1] = {
          ...last,
          text: `${last.text}\n[本条消息包含图片，但图片未提供给模型。]`,
        };
    }
    if (turn.config.decisionModel) {
      const decision = this.options.decision?.(turn.config) ?? new OpenAIDecision(turn.config);
      const result = parseDecisionResult(
        await decision.evaluate(
          [
            {
              role: "system",
              text: `当前会话：${context.event.conversationType === "group" ? "群聊" : "私聊"}。\n${turn.config.systemPrompt}`,
            },
            ...history,
          ],
          signal,
        ),
      );
      signal.throwIfAborted();
      const passed =
        result.type === "probability" && result.probability > turn.config.decisionThreshold;
      turn.decision = {
        status: "evaluated",
        result,
        threshold: turn.config.decisionThreshold,
        passed,
      };
      if (!passed) {
        this.record(context.event, {
          status: "skipped",
          reason: result.type === "refusal" ? "decision-refused" : "decision-threshold",
        });
        this.finish(context.event);
        return [];
      }
      this.record(context.event, {
        status: "generating",
        startedAt: new Date(this.now()).toISOString(),
      });
    }
    turn.stage = "model";
    const model = this.options.model?.(turn.config) ?? new OpenAICompatibleModel(turn.config);
    const response = await model.generate(
      {
        messages: [{ role: "system", text: turn.config.systemPrompt }, ...history],
        maxOutputTokens: turn.config.maxOutputTokens,
      },
      signal,
    );
    signal.throwIfAborted();
    turn.response = response;
    this.record(context.event, { status: "generated", response });
    return [
      {
        type: "message.send" as const,
        target: { ...context.event.origin, conversationId: context.event.conversationId },
        content: { type: "text" as const, text: response.text },
      },
    ];
  }

  private record(event: RuntimeEvent, processing: MessageProcessing): void {
    const decision = this.turns.get(eventKey(event))?.decision;
    this.logs.recordProcessing(event, { ...processing, ...(decision ? { decision } : {}) });
  }

  private finish(event: RuntimeEvent): void {
    const key = eventKey(event);
    this.turns.get(key)?.controller.abort();
    this.turns.delete(key);
  }
  dispose(): void {
    this.unsubscribe();
    for (const turn of this.turns.values()) turn.controller.abort();
    this.turns.clear();
    this.shared.clear();
    this.replies.clear();
  }
}
