import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { wrapLanguageModel, extractReasoningMiddleware } from "ai";
import axios from "axios";

export interface VendorSnapshot {
  vendorId: string;
  vendorCodeJs: string;
  vendorInputs: Record<string, string>;
  modelMeta: any;
  think: boolean;
  thinkLevel: 0 | 1 | 2 | 3;
  /** Sampling config from o_agentDeploy; passed to DurableAgent's GenerationSettings. */
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * Module-level helper that materializes a Toonflow vendor's transformed JS code
 * into the exports object the vendor file would normally produce.
 *
 * Kept OUTSIDE the workflow step body so the workflow SDK's closure analyzer
 * does not try to serialize the Function constructor as a step argument.
 *
 * SECURITY: we deliberately diverge from src/utils/vm.ts here. Workflow SDK's
 * step closure analysis is incompatible with vm2's sandbox wrapping, so we use
 * new Function() instead. The executed code is loaded from data/vendor/ files,
 * which Toonflow itself controls (admin-configured providers), not arbitrary
 * user input. Only pre-serialized vendor inputs (strings) are injected.
 */
function instantiateVendor(snapshot: VendorSnapshot) {
  const exports: Record<string, any> = {};
  // Match Toonflow's src/utils/vm.ts pattern: do NOT pre-inject `vendor` — the
  // vendor file declares `const vendor = {...}` itself and exports it. We
  // mutate exports.vendor.inputValues afterward with the user's DB config.
  const sandbox: Record<string, any> = {
    createOpenAI,
    createDeepSeek,
    createAnthropic,
    createOpenAICompatible,
    createXai,
    createGoogleGenerativeAI,
    axios,
    fetch,
    exports,
    logger: (m: any) => console.log(`【VM】${typeof m === "string" ? m : JSON.stringify(m)}`),
  };
  const argNames = Object.keys(sandbox);
  const argValues = argNames.map((k) => sandbox[k]);
  const code = snapshot.vendorCodeJs.replace(/export\s*\{\s*\};?/g, "");
  const fn = new Function(...argNames, `"use strict";\n${code}`);
  fn(...argValues);

  if (exports.vendor) {
    Object.assign(exports.vendor.inputValues ?? {}, snapshot.vendorInputs);
    exports.vendor.models = [snapshot.modelMeta];
  }
  return exports;
}

/**
 * Generic workflow-compatible model factory. Inside the step it materializes
 * the Toonflow vendor (e.g. data/vendor/kimicoding.ts) and invokes its
 * textRequest export to get a LanguageModelV3.
 *
 * Pattern matches @workflow/ai/openai: top-level function returning an inner
 * async whose body carries 'use step'. Only the serializable `snapshot`
 * crosses the step boundary.
 */
export function toonflowModel(snapshot: VendorSnapshot) {
  return async () => {
    "use step";
    const exports = instantiateVendor(snapshot);
    const textRequest = exports.textRequest as (m: any, t: boolean, tl: 0 | 1 | 2 | 3) => any;
    if (typeof textRequest !== "function") {
      throw new Error(`vendor ${snapshot.vendorId} did not export textRequest`);
    }
    const baseModel = textRequest(snapshot.modelMeta, snapshot.think, snapshot.thinkLevel);
    // Match the old u.Ai.Text().stream() path, which wrapped the model with
    // extractReasoningMiddleware so models that return their chain-of-thought as
    // a <reasoning_content> text tag get it split out as reasoning instead of
    // leaking into the final answer text.
    return wrapLanguageModel({
      model: baseModel,
      middleware: extractReasoningMiddleware({ tagName: "reasoning_content", separator: "\n" }),
    });
  };
}
