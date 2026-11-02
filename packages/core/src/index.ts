export type { Decision, DecisionResult } from "./decision.ts";
export { parseDecisionResult } from "./decision.ts";
export type {
  Model,
  ModelImage,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from "./model.ts";
export { parseModelResponse, parseModelUsage } from "./model.ts";
export { parseActionProposal, parseEvent } from "./validation.ts";

export type Awaitable<T> = T | Promise<T>;
export type Dispose = () => Awaitable<void>;

export interface ChannelIdentity {
  readonly channelId: string;
  readonly accountId: string;
}

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ImageAttachment {
  readonly type: "image";
  readonly url: string;
  readonly mediaType: string;
  readonly name?: string;
}

export interface MediaContent {
  readonly type: "message";
  readonly text: string;
  readonly images: readonly ImageAttachment[];
}

export interface RuntimeEvent {
  readonly id: string;
  readonly origin: ChannelIdentity;
  readonly timestamp: string;
  readonly actorId: string;
  readonly conversationId: string;
  /** 缺省表示渠道尚未提供分类；不根据标识符格式猜测。 */
  readonly conversationType?: "direct" | "group" | "channel";
  /** 渠道明确识别出的直接寻址信息，例如群内 @角色；不作为群聊调用门槛。 */
  readonly directedToCharacter?: boolean;
  readonly content: TextContent | MediaContent;
}

export interface MessageTarget extends ChannelIdentity {
  readonly conversationId: string;
}

export interface ActionProposal {
  readonly type: "message.send";
  readonly target: MessageTarget;
  readonly content: TextContent;
}

export interface SendAction extends ActionProposal {
  readonly id: string;
  readonly eventId: string;
}

export type EventResult =
  | { readonly status: "duplicate"; readonly eventId: string }
  | { readonly status: "observed"; readonly eventId: string }
  | {
      readonly status: "processed";
      readonly eventId: string;
      readonly sentCount: number;
      readonly blockedCount: number;
    };

export interface ChannelContext {
  readonly signal: AbortSignal;
  readonly emit: (event: unknown) => Promise<EventResult>;
}

export interface Channel {
  readonly identity: ChannelIdentity;
  setup(context: ChannelContext): Awaitable<Dispose>;
  start(): Awaitable<void>;
  stop(): Awaitable<void>;
  send(action: SendAction, signal: AbortSignal): Awaitable<void>;
}

export interface EventContext {
  readonly event: RuntimeEvent;
  /** 包含当前事件；按处理顺序排列的只读短期上下文快照。 */
  readonly history: readonly RuntimeEvent[];
  readonly signal: AbortSignal;
}

export interface ActionContext extends EventContext {
  readonly action: SendAction;
}

export type PipelineStage =
  | "onEvent"
  | "beforeHandle"
  | "handle"
  | "beforeSend"
  | "send"
  | "afterSend";

export interface PipelineErrorContext extends EventContext {
  readonly stage: PipelineStage;
  readonly error: unknown;
  readonly sentCount: number;
}

export type StageHook<Context, Result> = (
  context: Context,
) => Awaitable<Result | undefined> | Awaitable<void>;

export interface RuntimeHooks {
  readonly onEvent?: (context: EventContext) => Awaitable<void>;
  readonly beforeHandle?: StageHook<EventContext, "continue" | "observe">;
  readonly handle?: StageHook<EventContext, readonly ActionProposal[]>;
  /** 至少一个 allow 且没有 deny 才发送；观察型 Hook 的 undefined 不表示授权。 */
  readonly beforeSend?: StageHook<ActionContext, "allow" | "deny">;
  readonly afterSend?: (context: ActionContext) => Awaitable<void>;
  readonly onError?: (context: PipelineErrorContext) => Awaitable<void>;
}
