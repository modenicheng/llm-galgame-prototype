import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Common control mode for author config
// ---------------------------------------------------------------------------

export type ControlMode = "locked" | "preferred" | "free";

export interface AudioConfig {
  enabled: boolean;
  provider: "disabled" | "mock";
  active_target_lines: number;
  refill_threshold_lines: number;
  branch_prefetch_lines: number;
  batch_size: number;
  max_concurrency: number;
  mock_latency_ms: number;
  output_dir: string;
  /** V2 sections (optional; legacy flat fields remain for CLI compat). */
  planner?: AudioPlannerConfig;
  playback?: AudioPlaybackConfig;
  synthesis?: AudioSynthesisConfig;
  cache?: AudioCacheConfig;
}

/** V2 media planner tuning (lines). */
export interface AudioPlannerConfig {
  candidate_prefetch_lines: number;
  max_active_future_lines: number;
}

/** V2 browser playback buffering (milliseconds). */
export interface AudioPlaybackConfig {
  startup_buffer_ms: number;
  critical_watermark_ms: number;
  low_watermark_ms: number;
  target_buffer_ms: number;
  /** 每句角色音频开播前的固定延迟（同步视觉与听觉；0 = 不延迟）。 */
  voice_delay_ms: number;
}

/** V2 synthesis provider settings (Node-side only; never serialized to web). */
export interface AudioSynthesisConfig {
  provider: "disabled" | "mock" | "dashscope";
  max_concurrency: number;
  model_profile: string;
  api_key_env: string;
  format: "pcm_s16le";
  sample_rate: number;
}

/** V2 IndexedDB cache tuning (browser-side). */
export interface AudioCacheConfig {
  max_bytes: number;
  cleanup_target_bytes: number;
  write_batch_bytes: number;
  write_flush_interval_ms: number;
  partial_ttl_minutes: number;
  candidate_ttl_hours: number;
}

/** Interaction-mode policy (mode allow-list, option ranges, input limits). */
export interface InteractionPolicyConfig {
  allowed_modes: Array<"choice" | "hybrid" | "input">;
  default_mode: "choice" | "hybrid" | "input";

  options: {
    min_count: number;
    max_count: number;
  };

  input: {
    max_length: number;
    max_consecutive_pure_input: number;
  };

  legacy_choice: {
    allow_runtime_compatibility: boolean;
    allow_model_output: boolean;
  };
}

interface RefinementContext {
  addIssue(issue: unknown): void;
}

export interface AppConfig {
  api: {
    model: string;
    base_url?: string;
    api_key_env: string;
    timeout_ms: number;
    token_limit_field: "max_completion_tokens" | "max_tokens";
  };
  generation: {
    /** Model output protocol: legacy JSONL or the new Gal DSL (docs §87). */
    protocol: "jsonl" | "dsl";
    temperature: number;
    max_tokens: number;
    repair_attempts: number;
  };
  /** Text buffering thresholds (docs §74): when to start/refill playback. */
  text_buffer: {
    start_threshold_lines: number;
    target_lines: number;
    refill_threshold_lines: number;
  };
  /** Asset catalog location (docs §57). */
  assets: {
    catalog: string;
  };
  prefetch: {
    branch_dialogue_lines: number;
    branch_concurrency: number;
    /** Input bridge protocol contract (schema still enforces the shape). */
    input_bridge: {
      /** Whether bridge narration is materialized and played. */
      enabled: boolean;
      min_events: number;
      max_events: number;
      only_narration: boolean;
    };
  };
  /** Free-text input presentation. */
  input: {
    /** How the player's own line is presented (only "dialogue" is implemented). */
    kind: "dialogue";
    /** Two-Enter flow: preview confirmation before committing the input. */
    require_preview_confirmation: boolean;
    /** Show the input-response generation state in the preview (debug only). */
    show_generation_status: boolean;
  };
  /** Interaction-mode policy (mode allow-list, option ranges, input limits). */
  interaction: InteractionPolicyConfig;
  debug: {
    /** Render runtime status panels even without --debug-runtime. */
    runtime_status: boolean;
  };
  media: {
    audio: AudioConfig;
  };
  /** V2: default host entrypoint. */
  app: {
    default_host: "web" | "cli";
  };
  /** V2: local web host settings. */
  local_web: {
    host: string;
    port: number;
    open_browser: boolean;
    controller_limit: number;
  };
  /** Character → voice profile mapping (V2). */
  characters: Record<string, { name: string; voice_profile: string }>;
  game: {
    history_events: number;
    sessions_dir: string;
    show_line_ids: boolean;
  };
}

// ---------------------------------------------------------------------------
// Configuration sections
// ---------------------------------------------------------------------------

/** V2 audio synthesis/playback/cache sub-schemas. */
const AudioPlannerConfigSchema = z
  .object({
    candidate_prefetch_lines: z.number().int().min(0).max(20).default(1),
    max_active_future_lines: z.number().int().min(1).max(50).default(4),
  })
  .default({ candidate_prefetch_lines: 1, max_active_future_lines: 4 });

const AudioPlaybackConfigSchema = z
  .object({
    startup_buffer_ms: z.number().int().min(0).max(10_000).default(350),
    critical_watermark_ms: z.number().int().min(0).max(60_000).default(500),
    low_watermark_ms: z.number().int().min(0).max(120_000).default(2500),
    target_buffer_ms: z.number().int().min(0).max(300_000).default(6500),
    voice_delay_ms: z.number().int().min(0).max(60_000).default(0),
  })
  .default({
    startup_buffer_ms: 350,
    critical_watermark_ms: 500,
    low_watermark_ms: 2500,
    target_buffer_ms: 6500,
    voice_delay_ms: 0,
  });

const AudioSynthesisConfigSchema = z
  .object({
    provider: z.enum(["disabled", "mock", "dashscope"]).default("dashscope"),
    max_concurrency: z.number().int().min(1).max(10).default(2),
    model_profile: z.string().min(1).default("cosyvoice_v3_flash"),
    api_key_env: z.string().min(1).default("DASHSCOPE_API_KEY"),
    format: z.literal("pcm_s16le").default("pcm_s16le"),
    sample_rate: z.number().int().min(8000).max(48000).default(22050),
  })
  .default({
    provider: "dashscope",
    max_concurrency: 2,
    model_profile: "cosyvoice_v3_flash",
    api_key_env: "DASHSCOPE_API_KEY",
    format: "pcm_s16le",
    sample_rate: 22050,
  });

const AudioCacheConfigSchema = z
  .object({
    max_bytes: z.number().int().positive().default(536_870_912),
    cleanup_target_bytes: z.number().int().positive().default(402_653_184),
    write_batch_bytes: z.number().int().positive().default(262_144),
    write_flush_interval_ms: z.number().int().positive().default(300),
    partial_ttl_minutes: z.number().int().positive().default(10),
    candidate_ttl_hours: z.number().int().positive().default(1),
  })
  .default({
    max_bytes: 536_870_912,
    cleanup_target_bytes: 402_653_184,
    write_batch_bytes: 262_144,
    write_flush_interval_ms: 300,
    partial_ttl_minutes: 10,
    candidate_ttl_hours: 1,
  });

// ---------------------------------------------------------------------------
// Configuration sections
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Author config types
// ---------------------------------------------------------------------------

export interface ControlSection {
  world: { mode: ControlMode };
  characters: { mode: ControlMode };
  plot: { mode: ControlMode };
  endings: { mode: ControlMode };
  style: { mode: ControlMode };
}

export interface RulesConfig {
  locked: string[];
  preferred: string[];
  seeds: string[];
}

export interface AuthorConfig {
  control: ControlSection;
  rules: RulesConfig;
}

const AudioConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(["disabled", "mock"]).default("disabled"),
    active_target_lines: z.number().int().min(1).max(50).default(3),
    refill_threshold_lines: z.number().int().min(0).max(49).default(2),
    branch_prefetch_lines: z.number().int().min(0).max(20).default(2),
    batch_size: z.number().int().min(1).max(20).default(2),
    max_concurrency: z.number().int().min(1).max(10).default(2),
    mock_latency_ms: z.number().int().min(0).max(60_000).default(800),
    output_dir: z.string().min(1).default("assets/.tts-cache"),
    // V2 nested sections (optional; legacy flat fields remain for CLI compat).
    planner: AudioPlannerConfigSchema.optional(),
    playback: AudioPlaybackConfigSchema.optional(),
    synthesis: AudioSynthesisConfigSchema.optional(),
    cache: AudioCacheConfigSchema.optional(),
  })
  .superRefine((value, context: RefinementContext) => {
    if (value.refill_threshold_lines >= value.active_target_lines) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["refill_threshold_lines"],
        message: "refill_threshold_lines 必须小于 active_target_lines。"
      });
    }
    if (value.enabled && value.provider === "disabled") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: "启用音频预取时必须选择可用 provider；预研演示可使用 mock。"
      });
    }
  });

/** Interaction-mode policy schema; validates like the other sections. */
const InteractionPolicyConfigSchema = z
  .object({
    allowed_modes: z
      .array(z.enum(["choice", "hybrid", "input"]))
      .min(1)
      .default(["choice", "hybrid", "input"]),
    // Reserved: validated against allowed_modes but not consumed at runtime —
    // the interaction mode is chosen by the model, never by this default.
    default_mode: z.enum(["choice", "hybrid", "input"]).default("hybrid"),
    options: z
      .object({
        min_count: z.number().int().min(2).default(2),
        max_count: z.number().int().max(5).default(5),
      })
      .default({ min_count: 2, max_count: 5 }),
    input: z
      .object({
        max_length: z.number().int().min(1).max(2000).default(500),
        max_consecutive_pure_input: z.number().int().min(0).default(1),
      })
      .default({ max_length: 500, max_consecutive_pure_input: 1 }),
    legacy_choice: z
      .object({
        allow_runtime_compatibility: z.boolean().default(true),
        allow_model_output: z.boolean().default(false),
      })
      .default({ allow_runtime_compatibility: true, allow_model_output: false }),
  })
  .superRefine((value, context: RefinementContext) => {
    if (!value.allowed_modes.includes(value.default_mode)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default_mode"],
        message: "default_mode 必须存在于 allowed_modes。",
      });
    }
    if (value.options.min_count > value.options.max_count) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "options.min_count 不能大于 options.max_count。",
      });
    }
  })
  .default({
    allowed_modes: ["choice", "hybrid", "input"],
    default_mode: "hybrid",
    options: { min_count: 2, max_count: 5 },
    input: { max_length: 500, max_consecutive_pure_input: 1 },
    legacy_choice: { allow_runtime_compatibility: true, allow_model_output: false },
  });

const ConfigSchema = z.object({
  api: z.object({
    model: z.string().min(1),
    base_url: z.string().url().optional(),
    api_key_env: z.string().min(1).default("OPENAI_API_KEY"),
    timeout_ms: z.number().int().positive().default(60_000),
    token_limit_field: z
      .enum(["max_completion_tokens", "max_tokens"])
      .default("max_completion_tokens")
  }),
  generation: z.object({
    protocol: z.enum(["jsonl", "dsl"]).default("jsonl"),
    temperature: z.number().min(0).max(2).default(0.9),
    max_tokens: z.number().int().positive().default(2200),
    repair_attempts: z.number().int().min(0).max(5).default(2)
  }),
  text_buffer: z
    .object({
      start_threshold_lines: z.number().int().min(0).default(2),
      target_lines: z.number().int().min(1).default(6),
      refill_threshold_lines: z.number().int().min(0).default(3),
    })
    .superRefine((value, context: RefinementContext) => {
      if (value.refill_threshold_lines >= value.target_lines) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["refill_threshold_lines"],
          message: "text_buffer.refill_threshold_lines 必须小于 target_lines。",
        });
      }
    })
    .default({ start_threshold_lines: 2, target_lines: 6, refill_threshold_lines: 3 }),
  assets: z
    .object({
      catalog: z.string().min(1).default("assets/resources.yaml"),
    })
    .default({ catalog: "assets/resources.yaml" }),
  prefetch: z
    .object({
      branch_dialogue_lines: z.number().int().min(1).max(20).default(3),
      branch_concurrency: z.number().int().min(1).max(10).default(3),
      input_bridge: z
        .object({
          enabled: z.boolean().default(true),
          min_events: z.number().int().min(1).max(2).default(1),
          max_events: z.number().int().min(1).max(2).default(2),
          only_narration: z.boolean().default(true),
        })
        .default({
          enabled: true,
          min_events: 1,
          max_events: 2,
          only_narration: true,
        }),
    })
    .superRefine((value, context: RefinementContext) => {
      if (value.input_bridge.min_events > value.input_bridge.max_events) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["input_bridge"],
          message: "input_bridge.min_events 不能大于 max_events。",
        });
      }
    }),
  input: z
    .object({
      kind: z.enum(["dialogue"]).default("dialogue"),
      require_preview_confirmation: z.boolean().default(true),
      show_generation_status: z.boolean().default(false),
    })
    .default({
      kind: "dialogue",
      require_preview_confirmation: true,
      show_generation_status: false,
    }),
  interaction: InteractionPolicyConfigSchema,
  debug: z
    .object({
      runtime_status: z.boolean().default(false),
    })
    .default({ runtime_status: false }),
  media: z.object({
    audio: AudioConfigSchema
  }),
  app: z
    .object({
      default_host: z.enum(["web", "cli"]).default("web"),
    })
    .default({ default_host: "web" }),
  local_web: z
    .object({
      host: z.string().min(1).default("127.0.0.1"),
      port: z.number().int().min(0).max(65535).default(0),
      open_browser: z.boolean().default(true),
      controller_limit: z.number().int().min(1).max(8).default(1),
    })
    .default({
      host: "127.0.0.1",
      port: 0,
      open_browser: true,
      controller_limit: 1,
    }),
  characters: z.record(
    z.string(),
    z.object({
      name: z.string().min(1),
      voice_profile: z.string().min(1),
    }),
  ).default({}),
  game: z.object({
    history_events: z.number().int().positive().default(80),
    sessions_dir: z.string().min(1).default("sessions"),
    show_line_ids: z.boolean().default(true)
  })
});

// ---------------------------------------------------------------------------
// Author config Zod schemas & loader
// ---------------------------------------------------------------------------

const ControlSectionSchema = z.object({
  world: z.object({ mode: z.enum(["locked", "preferred", "free"]).default("preferred") }).default({ mode: "preferred" }),
  characters: z.object({ mode: z.enum(["locked", "preferred", "free"]).default("preferred") }).default({ mode: "preferred" }),
  plot: z.object({ mode: z.enum(["locked", "preferred", "free"]).default("free") }).default({ mode: "free" }),
  endings: z.object({ mode: z.enum(["locked", "preferred", "free"]).default("free") }).default({ mode: "free" }),
  style: z.object({ mode: z.enum(["locked", "preferred", "free"]).default("locked") }).default({ mode: "locked" }),
});

const RulesConfigSchema = z.object({
  locked: z.array(z.string()).default([]),
  preferred: z.array(z.string()).default([]),
  seeds: z.array(z.string()).default([]),
});

const AuthorConfigSchema = z.object({
  control: ControlSectionSchema.default({
    world: { mode: "preferred" },
    characters: { mode: "preferred" },
    plot: { mode: "free" },
    endings: { mode: "free" },
    style: { mode: "locked" },
  }),
  rules: RulesConfigSchema.default({ locked: [], preferred: [], seeds: [] }),
});

const DEFAULT_AUTHOR_CONFIG: AuthorConfig = {
  control: {
    world: { mode: "preferred" },
    characters: { mode: "preferred" },
    plot: { mode: "free" },
    endings: { mode: "free" },
    style: { mode: "locked" },
  },
  rules: {
    locked: [],
    preferred: [],
    seeds: [],
  },
};

/**
 * Load an optional author.yaml configuration file.
 * Returns sensible defaults when the file does not exist.
 */
export async function loadAuthorConfig(authorConfigPath: string): Promise<AuthorConfig> {
  try {
    const absolutePath = path.resolve(authorConfigPath);
    const raw = await readFile(absolutePath, "utf8");
    const parsed: unknown = parse(raw);
    // Treat empty/whitespace-only YAML as empty object so defaults apply
    if (parsed === null || parsed === undefined) {
      return { ...DEFAULT_AUTHOR_CONFIG };
    }
    return AuthorConfigSchema.parse(parsed) as AuthorConfig;
  } catch (error) {
    // ENOENT on both Unix and Windows
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_AUTHOR_CONFIG };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Config loaders
// ---------------------------------------------------------------------------

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const absolutePath = path.resolve(configPath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed: unknown = parse(raw);
  return ConfigSchema.parse(parsed) as AppConfig;
}

export function loadApiKey(config: AppConfig): string {
  const apiKey = process.env[config.api.api_key_env];
  if (!apiKey) {
    throw new Error(
      `环境变量 ${config.api.api_key_env} 未设置。请复制 .env.example 为 .env 并填写密钥。`
    );
  }
  return apiKey;
}
