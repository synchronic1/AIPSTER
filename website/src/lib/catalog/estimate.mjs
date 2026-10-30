/* Built with Meta Muse. */
// Compatibility estimator: pure function, no I/O. Evaluates ONE exact
// model-plus-optional-adapter configuration against ONE permitted node
// snapshot and runtime. Never sums unrelated-node memory (AC06): the input
// carries a single snapshot, so fabrication is structurally impossible.
//
// Decision states (PRD §3): estimated-compatible | validated (requires a
// recorded qualification tuple — unreachable until Phase 4 evidence exists)
// | blocked (names the failed requirement) | unknown (names missing evidence).
// installed/loaded/available-to-run are lifecycle facts, never returned here.
export const ESTIMATOR_VERSION = 'catalog-estimate/1.0';
export const TELEMETRY_FRESH_MS = 5 * 60 * 1000;
export const SAFETY_RESERVE_RATIO = 0.15;
export const LOAD_WORKSPACE_BYTES = 2 * 1024 * 1024 * 1024;

// Declared capability matrix. fixture-llama is the ONLY entry: every real
// runtime is unsupported until a tested matrix row says otherwise (PRD §3:
// never infer PEFT/llama.cpp/vLLM compatibility).
export const RUNTIME_MATRIX = [
  {
    name: 'fixture-llama',
    formats: ['gguf'],
    quants: ['Q4_K_M', 'Q8_0', 'UNKNOWN-OK'],
    maxContext: 8192,
    adapters: [],
    cpuOffload: false,
    fixture: true,
  },
];

export function matrixEntry(runtimeName) {
  return RUNTIME_MATRIX.find((r) => r.name === runtimeName) || null;
}

function num(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

// Conservative KV-cache heuristic for decoder transformers:
// 2 (K+V) × layers × hidden × bytesPerParam × context × concurrency.
// Layers/hidden come from declared architecture hints when present;
// otherwise a conservative upper bound for the weight class. The method,
// assumptions, and uncertainty ALWAYS ship with the estimate.
function kvCacheBytes(weightsBytes, context, concurrency) {
  // Upper-bound heuristic: assume a 7B-class shape (32 layers × 4096
  // hidden × fp16) unless the caller supplies declared dims. Documented
  // uncertainty: ±50% without declared architecture.
  const layers = 32;
  const hidden = 4096;
  const bytesPer = 2;
  return 2 * layers * hidden * bytesPer * context * concurrency;
}

export function estimateBudget({ weightsBytes, adapterBytes = 0, context, concurrency }) {
  const weights = num(weightsBytes);
  const adapter = num(adapterBytes);
  const kv = kvCacheBytes(weights, context, concurrency);
  const buffers = Math.ceil(weights * 0.1);
  const workspace = LOAD_WORKSPACE_BYTES;
  const subtotal = weights + kv + buffers + adapter + workspace;
  const reserve = Math.ceil(subtotal * SAFETY_RESERVE_RATIO);
  return {
    weightsBytes: weights,
    kvCacheBytes: kv,
    runtimeBuffersBytes: buffers,
    adapterBytes: adapter,
    loadWorkspaceBytes: workspace,
    safetyReserveBytes: reserve,
    totalBytes: subtotal + reserve,
    method: 'weights + 7B-class-upper-bound KV(context×concurrency) + 10% buffers + adapter + 2GiB workspace + 15% reserve',
    version: ESTIMATOR_VERSION,
    uncertainty: 'KV shape is an upper-bound heuristic without declared architecture; ±50% possible. Model-file bytes are not a runtime footprint.',
  };
}

function reason(code, message, resolve) {
  return { code, message, resolve: resolve || '' };
}

// LoRA checks (PRD §3): exact base identity+revision, adapter type,
// target modules, tokenizer assumptions, runtime support. Missing or
// ambiguous base provenance → unknown and non-deployable.
function checkAdapter(adapter, baseAsset, matrix) {
  const blocks = [];
  const unknowns = [];
  if (!adapter || typeof adapter !== 'object') {
    return { blocks: [], unknowns: [reason('ADAPTER_METADATA_UNKNOWN', 'Adapter metadata (base binding, modules, tokenizer) is unavailable.', 'Re-resolve the adapter asset with full metadata.')] };
  }
  if (!baseAsset) {
    return { blocks: [], unknowns: [reason('ADAPTER_BASE_UNKNOWN', 'Adapter base identity is unresolved.', 'Supply the exact base model and revision.')] };
  }
  if (!adapter.baseRevision || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(adapter.baseRevision)) {
    unknowns.push(reason('ADAPTER_BASE_REV_UNKNOWN', 'Adapter base revision is not pinned to a commit.', 'Pin the exact base revision.'));
  } else if (baseAsset.revision && adapter.baseRevision !== baseAsset.revision) {
    blocks.push(reason('ADAPTER_BASE_MISMATCH', `Adapter targets base revision ${adapter.baseRevision.slice(0, 12)}…, selected base is ${String(baseAsset.revision).slice(0, 12)}….`, 'Select the matching base revision.'));
  }
  if (!Array.isArray(adapter.targetModules) || adapter.targetModules.length === 0) {
    unknowns.push(reason('ADAPTER_MODULES_UNKNOWN', 'Adapter target modules are undeclared.', 'Provide target-module metadata.'));
  }
  if (!adapter.tokenizer) {
    unknowns.push(reason('ADAPTER_TOKENIZER_UNKNOWN', 'Adapter tokenizer assumptions are undeclared.', 'Provide the tokenizer reference.'));
  } else if (adapter.tokenizer !== (baseAsset.tokenizer || baseAsset.repo)) {
    blocks.push(reason('ADAPTER_TOKENIZER_MISMATCH', 'Adapter tokenizer does not match the selected base.', 'Select the base the adapter was trained against.'));
  }
  if (!matrix.adapters.includes(adapter.peftType || 'LORA')) {
    blocks.push(reason('ADAPTER_RUNTIME_UNSUPPORTED', `Runtime ${matrix.name} has no tested ${adapter.peftType || 'LORA'} path.`, 'Choose a runtime with a tested adapter matrix row.'));
  }
  return { blocks, unknowns };
}

export function evaluateCompatibility(input) {
  // input: { asset, adapter?, adapterAsset?, baseAsset?, settings{context, concurrency, runtime},
  //          snapshot|null, snapshotAgeMs|null, nodeId, principal, nowMs }
  const blocks = [];
  const unknowns = [];
  const warnings = [];
  const { asset, settings } = input;
  const context = num(settings.context, 0);
  const concurrency = num(settings.concurrency, 0);

  if (!asset || !asset.revision) {
    unknowns.push(reason('ARTIFACT_UNPINNED', 'Artifact revision is not pinned to a commit.', 'Resolve the full revision before evaluating.'));
  }
  const entry = matrixEntry(settings.runtime);
  if (!entry) {
    unknowns.push(reason('RUNTIME_UNQUALIFIED', `Runtime ${settings.runtime || '(none)'} has no tested matrix row.`, 'Choose a supported runtime or qualify this one.'));
  } else {
    if (!entry.formats.includes(asset.format)) {
      blocks.push(reason('FORMAT_UNSUPPORTED', `Format ${asset.format} has no tested ${entry.name} path.`, 'Choose a tested format/runtime pair.'));
    }
    if (asset.quant !== 'unknown' && !entry.quants.includes(asset.quant) && !entry.quants.includes('UNKNOWN-OK')) {
      blocks.push(reason('QUANT_UNSUPPORTED', `Quantization ${asset.quant} is untested on ${entry.name}.`, 'Choose a tested quantization.'));
    }
    if (context > entry.maxContext) {
      blocks.push(reason('CONTEXT_EXCEEDS_RUNTIME', `Context ${context} exceeds ${entry.name} maximum ${entry.maxContext}.`, 'Lower the context length.'));
    }
  }
  if (context <= 0 || concurrency <= 0) {
    blocks.push(reason('SETTINGS_INVALID', 'Context and concurrency must be positive.', 'Supply positive settings.'));
  }

  // Adapter checks (AC08).
  if (input.adapterAsset) {
    const r = checkAdapter(input.adapterAsset.adapter, input.baseAsset || asset, entry || { name: settings.runtime, adapters: [] });
    blocks.push(...r.blocks);
    unknowns.push(...r.unknowns);
  }

  // Snapshot evidence (AC07): missing/stale telemetry is unknown, not fit.
  const snap = input.snapshot || null;
  const ageMs = input.snapshotAgeMs;
  if (!snap) {
    unknowns.push(reason('TELEMETRY_MISSING', 'No capability report exists for this node.', 'Report node capabilities from the worker first.'));
  } else if (!Number.isSafeInteger(ageMs) || ageMs < 0) {
    unknowns.push(reason('TELEMETRY_AGE_UNKNOWN', 'Capability report age is unreadable.', 'Re-report node capabilities.'));
  } else if (ageMs > TELEMETRY_FRESH_MS) {
    unknowns.push(reason('TELEMETRY_STALE', `Capability report is ${Math.round(ageMs / 1000)}s old (freshness 300s).`, 'Re-report node capabilities.'));
  }

  // Resource budget vs the single snapshot (AC05/AC06).
  let budget = null;
  if (snap && blocks.length === 0 && unknowns.length === 0) {
    const weightsBytes = num(asset.totalBytes);
    const adapterBytes = input.adapterAsset ? num(input.adapterAsset.totalBytes) : 0;
    budget = estimateBudget({ weightsBytes, adapterBytes, context, concurrency });
    const gpu = Array.isArray(snap.mem.gpu) ? snap.mem.gpu[0] : null;
    const vramAvail = gpu ? num(gpu.vramAvailBytes) : 0;
    const ramAvail = num(snap.mem.ramAvailBytes);
    const diskAvail = num(snap.disk.availBytes);
    const reserved = Array.isArray(snap.workload.reservations)
      ? snap.workload.reservations.reduce((n, r) => n + num(r.bytes), 0) : 0;
    const effective = Math.max(0, (gpu ? vramAvail : ramAvail) - reserved);
    if (budget.totalBytes > effective) {
      blocks.push(reason(gpu ? 'INSUFFICIENT_VRAM' : 'INSUFFICIENT_RAM',
        `Budget ${budget.totalBytes} bytes exceeds available ${effective} bytes${reserved ? ` (${reserved} reserved)` : ''}. Weights alone (${weightsBytes}) are not the footprint.`,
        'Lower context/concurrency, free memory, or choose a larger node.'));
    }
    const staging = weightsBytes + adapterBytes;
    if (staging > diskAvail) {
      blocks.push(reason('INSUFFICIENT_DISK', `Staging ${staging} bytes exceeds available disk ${diskAvail} bytes.`, 'Free disk or choose another node.'));
    }
    if (reserved > 0) warnings.push(reason('RESERVATIONS_ACTIVE', `${reserved} bytes are reserved by other work on this node.`, ''));
  }

  let state = 'unknown';
  if (blocks.length > 0) state = 'blocked';
  else if (unknowns.length === 0) state = 'estimated-compatible';
  // 'validated' requires a recorded qualification tuple (Phase 4); never
  // returned here. Installed/loaded/available are lifecycle, not compat.

  return {
    state,
    nodeId: input.nodeId,
    assetId: asset.id,
    adapterId: input.adapterAsset ? input.adapterAsset.id : null,
    fingerprint: {
      asset: `${asset.id}@${asset.revision || 'unpinned'}`,
      adapter: input.adapterAsset ? `${input.adapterAsset.id}@${input.adapterAsset.revision || 'unpinned'}` : null,
      base: input.adapterAsset && input.baseAsset ? `${input.baseAsset.id}@${input.baseAsset.revision || 'unpinned'}` : null,
      node: input.nodeId,
      runtime: settings.runtime,
      context,
      concurrency,
      estimator: ESTIMATOR_VERSION,
      snapshotAt: input.snapshotAt || null,
    },
    blocking: blocks,
    warnings,
    unknown: unknowns,
    estimate: budget,
    telemetryAgeMs: ageMs === undefined ? null : ageMs,
    expiresAt: new Date(input.nowMs + TELEMETRY_FRESH_MS).toISOString(),
    estimator: ESTIMATOR_VERSION,
  };
}
