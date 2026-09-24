/**
 * Adaptador Anthropic: `baseUrl` do provedor vira o `baseURL` do SDK (gateway/proxy
 * compatível com a Messages API) e provedor local dispensa a chave.
 */
import { describe, expect, it } from "vitest";
import { createAnthropicProvider, type AnthropicSdkConstructor } from "../src/bots/providers/anthropic.js";
import type { ProviderConfig } from "../src/bots/providers/types.js";

function recordingSdk(): { Sdk: AnthropicSdkConstructor; options: Record<string, unknown>[] } {
  const options: Record<string, unknown>[] = [];
  class FakeAnthropic {
    models = { list: async () => ({ data: [{ id: "claude-opus-5" }] }) };
    messages = { create: async () => ({ content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) };
    constructor(opts: Record<string, unknown>) {
      options.push(opts);
    }
  }
  return { Sdk: FakeAnthropic as unknown as AnthropicSdkConstructor, options };
}

describe("anthropic — baseURL", () => {
  it("passa a baseUrl do provedor ao SDK", async () => {
    const { Sdk, options } = recordingSdk();
    const cfg: ProviderConfig = { id: "gw", name: "Gateway", kind: "anthropic", baseUrl: "https://gateway.exemplo.com/anthropic", apiKeyEnv: "GW_API_KEY" };
    const provider = createAnthropicProvider(cfg, { apiKey: "sk-ant-teste", sdk: Sdk });
    const models = await provider.listModels();
    expect(models[0].id).toBe("claude-opus-5");
    expect(options[0]).toMatchObject({ apiKey: "sk-ant-teste", baseURL: "https://gateway.exemplo.com/anthropic", maxRetries: 0 });
  });

  it("sem baseUrl, não manda baseURL (usa api.anthropic.com)", async () => {
    const { Sdk, options } = recordingSdk();
    const cfg: ProviderConfig = { id: "anthropic", name: "Anthropic", kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" };
    await createAnthropicProvider(cfg, { apiKey: "sk-ant-teste", sdk: Sdk }).listModels();
    expect(options[0]).not.toHaveProperty("baseURL");
  });

  it("gateway local compatível dispensa a chave; remoto sem chave falha citando o .env", async () => {
    const { Sdk, options } = recordingSdk();
    const local: ProviderConfig = { id: "litellm-anthropic", name: "L", kind: "anthropic", baseUrl: "http://192.168.0.5:4000" };
    expect((await createAnthropicProvider(local, { sdk: Sdk }).test()).ok).toBe(true);
    expect(options[0]).toMatchObject({ apiKey: "local", baseURL: "http://192.168.0.5:4000" });

    const remote: ProviderConfig = { id: "anthropic", name: "A", kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" };
    const result = await createAnthropicProvider(remote, { sdk: Sdk }).test();
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("ANTHROPIC_API_KEY");
  });
});
