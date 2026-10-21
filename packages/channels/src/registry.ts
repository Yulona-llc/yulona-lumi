import type { ChannelType } from "@yulona/shared";
import type { ChannelAdapter } from "./types";
import { widgetAdapter } from "./widget-adapter";
import type { AdapterOptions } from "./http";
import { createWhatsAppAdapter } from "./whatsapp";
import { createInstagramAdapter, createMessengerAdapter } from "./meta";
import { createTelegramAdapter } from "./telegram";
import { createSlackAdapter } from "./slack";

export class ChannelRegistry {
  private adapters = new Map<ChannelType, ChannelAdapter>();
  register(adapter: ChannelAdapter): this {
    if (this.adapters.has(adapter.type)) throw new Error(`Channel adapter already registered: ${adapter.type}`);
    this.adapters.set(adapter.type, adapter);
    return this;
  }
  get(type: ChannelType): ChannelAdapter | undefined {
    return this.adapters.get(type);
  }
  require(type: ChannelType): ChannelAdapter {
    const a = this.get(type);
    if (!a) throw new Error(`No adapter registered for channel: ${type}`);
    return a;
  }
  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }
}

/** Registry with every channel adapter. Options (fetch, apiBase, timeout) exist so tests can point at mock servers. */
export function createDefaultRegistry(o: AdapterOptions & { apiBases?: Partial<Record<ChannelType, string>> } = {}): ChannelRegistry {
  const b = o.apiBases ?? {};
  return new ChannelRegistry()
    .register(widgetAdapter)
    .register(createWhatsAppAdapter({ ...o, apiBase: b.whatsapp }))
    .register(createMessengerAdapter({ ...o, apiBase: b.facebook }))
    .register(createInstagramAdapter({ ...o, apiBase: b.instagram }))
    .register(createTelegramAdapter({ ...o, apiBase: b.telegram }))
    .register(createSlackAdapter({ ...o, apiBase: b.slack }));
}
