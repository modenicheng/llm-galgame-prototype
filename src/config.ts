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
}

interface RefinementContext {
  addIssue(issue: unknown): void;
}

interface PrefetchConfig {
  branch_dialogue_lines: number;
  branch_max_events: number;
  branch_concurrency: number;
}

export interface TextBufferConfig {
  refill_threshold_lines: number;
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
    temperature: number;
    max_tokens: number;
    repair_attempts: number;
  };
  text_buffer: TextBufferConfig;
  prefetch: {
    branch_dialogue_lines: number;
    branch_max_events: number;
    branch_concurrency: number;
  };
  autocomplete: AutocompleteConfig;
  media: {
    audio: AudioConfig;
  };
  game: {
    history_events: number;
    max_events_per_segment: number;
    sessions_dir: string;
    show_line_ids: boolean;
  };
}

// ---------------------------------------------------------------------------
// Configuration sections
// ---------------------------------------------------------------------------

export interface AutocompleteConfig {
  minimum_characters: number;
  debounce_ms: number;
  max_suffix_characters: number;
  confidence_threshold: number;
}

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
    output_dir: z.string().min(1).default("assets/audio")
  })
  .superRefine((value: AudioConfig, context: RefinementContext) => {
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
    temperature: z.number().min(0).max(2).default(0.9),
    max_tokens: z.number().int().positive().default(1400),
    repair_attempts: z.number().int().min(0).max(5).default(2)
  }),
  text_buffer: z
    .object({
      refill_threshold_lines: z.number().int().min(1).max(20).default(3),
    })
    .default({ refill_threshold_lines: 3 }),
  prefetch: z
    .object({
      branch_dialogue_lines: z.number().int().min(1).max(20).default(3),
      branch_max_events: z.number().int().min(1).max(50).default(8),
      branch_concurrency: z.number().int().min(1).max(10).default(3),
    })
    .superRefine((value: PrefetchConfig, context: RefinementContext) => {
      if (value.branch_max_events < value.branch_dialogue_lines) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["branch_max_events"],
          message: "branch_max_events 不能小于 branch_dialogue_lines。"
        });
      }
    }),
  autocomplete: z.object({
    minimum_characters: z.number().int().min(1).default(4),
    debounce_ms: z.number().int().min(0).max(5_000).default(350),
    max_suffix_characters: z.number().int().min(1).max(200).default(20),
    confidence_threshold: z.number().min(0).max(1).default(0.55),
  }).default({ minimum_characters: 4, debounce_ms: 350, max_suffix_characters: 20, confidence_threshold: 0.55 }),
  media: z.object({
    audio: AudioConfigSchema
  }),
  game: z.object({
    history_events: z.number().int().positive().default(80),
    max_events_per_segment: z.number().int().min(2).max(50).default(12),
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
