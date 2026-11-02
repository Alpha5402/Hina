import type { RuntimeEvent } from "@hina/core";

export function conversationKey(event: RuntimeEvent): string {
  return JSON.stringify([event.origin.channelId, event.origin.accountId, event.conversationId]);
}

export function eventKey(event: RuntimeEvent): string {
  return JSON.stringify([
    event.origin.channelId,
    event.origin.accountId,
    event.conversationId,
    event.id,
  ]);
}

export class ShortTermContext {
  private readonly conversations = new Map<
    string,
    readonly { readonly event: RuntimeEvent; readonly observedAt: number }[]
  >();

  constructor(
    private readonly eventsPerConversation: number,
    private readonly conversationLimit: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  append(event: RuntimeEvent): readonly RuntimeEvent[] {
    const key = conversationKey(event);
    const observedAt = this.now();
    for (const [conversation, entries] of this.conversations) {
      const retained = entries.filter((item) => observedAt - item.observedAt < this.ttlMs);
      if (retained.length === 0) this.conversations.delete(conversation);
      else this.conversations.set(conversation, retained);
    }
    const items = [...(this.conversations.get(key) ?? []), { event, observedAt }].slice(
      -this.eventsPerConversation,
    );
    this.conversations.delete(key);
    this.conversations.set(key, items);
    if (this.conversations.size > this.conversationLimit) {
      const oldest = this.conversations.keys().next().value;
      if (oldest !== undefined) this.conversations.delete(oldest);
    }
    return Object.freeze(items.map((item) => item.event));
  }

  clear(): void {
    this.conversations.clear();
  }
}
