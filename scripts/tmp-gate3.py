import io


def read(path):
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        return f.read().replace('\r\n', '\n')


def write(path, t):
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(t.replace('\n', '\r\n'))


# 1. web/src/main.ts: extract form mounting + submit (P2 both)
p = 'web/src/main.ts'
t = read(p)
start = t.index('  // M3.3 直通开玩：无既有世界时显示描述输入框 + 开局按钮。')
end = t.index('  const dialogueBox = new DialogueBox(')
block = t[start:end]
t = t[:start] + '  // M3.3 直通开玩：无既有世界时显示描述输入框 + 开局按钮（见下挂载函数）。\n  void mountWorldCreateForm(appRoot);\n\n  ' + t[end:]

helper = '''
/**
 * M3.3 直通开玩：无既有世界时在首屏挂载「创建世界」表单。
 * 提交 → POST /api/worlds（服务端换绑到新世界）→ 刷新进入正常开局流程。
 * /api/config 不可得时按「已有世界」处理，不阻塞正常启动。
 */
async function mountWorldCreateForm(appRoot: HTMLElement): Promise<void> {
  try {
    const response = await fetch("/api/config");
    const config = (await response.json()) as { has_world?: boolean };
    if (config.has_world !== false) return;
    const form = document.createElement("div");
    form.className = "world-create";
    form.innerHTML = [
      "<h2>创建你的世界</h2>",
      "<p>用一段话描述你想要的世界与故事，编剧将生成大纲并直接开局。</p>",
      '<textarea id="world-create-text" rows="6" placeholder="例如：平行世界的学园都市，转学生苏遥带着一台会对指纹反应的旧终端……"></textarea>',
      '<button id="world-create-button" type="button">生成世界并开局</button>',
      '<p id="world-create-error" style="color:#c0392b"></p>',
    ].join("");
    appRoot.appendChild(form);
    const button = form.querySelector<HTMLButtonElement>("#world-create-button")!;
    const textarea = form.querySelector<HTMLTextAreaElement>("#world-create-text")!;
    const error = form.querySelector<HTMLParagraphElement>("#world-create-error")!;
    button.addEventListener("click", () => {
      void submitWorldCreation(textarea.value, button, error);
    });
  } catch {
    // ignore — treat as "world exists"
  }
}

async function submitWorldCreation(
  text: string,
  button: HTMLButtonElement,
  error: HTMLParagraphElement,
): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    error.textContent = "请先填写世界描述。";
    return;
  }
  button.disabled = true;
  error.textContent = "生成中……（约需数十秒）";
  try {
    const createResponse = await fetch("/api/worlds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: trimmed }),
    });
    if (!createResponse.ok) {
      const body = (await createResponse.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${createResponse.status}`);
    }
    window.location.reload();
  } catch (err) {
    error.textContent = err instanceof Error ? err.message : String(err);
    button.disabled = false;
  }
}
'''
# append helpers at end of file
t = t.rstrip('\n') + '\n' + helper
write(p, t)
print('main.ts form extracted')

# 2. coordinator: maintenance applyRevision goes through the mutation chain (race fix)
p = 'src/application/graph/run-graph-coordinator.ts'
t = read(p)
old = '''  private async applyOutlineQuietly(ops: OutlineOp[], reason: string): Promise<void> {
    if (this.outline === undefined) return;
    try {
      this.outlineRevision = await this.outline.store.applyRevision(ops, reason);
      this.outlineNodes = this.outline.store.getOutline().nodes;
    } catch (err) {
      this.diagnostics.warn("RunGraphCoordinator", `大纲修订被拒绝（${reason}）：${String(err)}`);
    }
  }'''
new = '''  private applyOutlineQuietly(ops: OutlineOp[], reason: string): Promise<void> {
    return this.applyOutlineQuietlyInner(ops, reason, false);
  }

  /**
   * 大纲修订统一入口。确定性迁移已在互斥链内（viaChain=false 直呼）；后台
   * 维护在链外（viaChain=true）——落盘必须入链串行，否则两个 await 点交错
   * 会基于同一基线各算 revision+1，产生重复修订号/丢更新。
   */
  private async applyOutlineQuietlyInner(
    ops: OutlineOp[],
    reason: string,
    viaChain: boolean,
  ): Promise<void> {
    if (this.outline === undefined) return;
    const run = async (): Promise<void> => {
      try {
        this.outlineRevision = await this.outline.store.applyRevision(ops, reason);
        this.outlineNodes = this.outline.store.getOutline().nodes;
      } catch (err) {
        this.diagnostics.warn("RunGraphCoordinator", `大纲修订被拒绝（${reason}）：${String(err)}`);
      }
    };
    if (viaChain) {
      await this.enqueue(run);
    } else {
      await run();
    }
  }'''
assert old in t
t = t.replace(old, new, 1)
t = t.replace('        await this.applyOutlineQuietly(allowed, "M3.4：后台维护（LLM）");',
              '        await this.applyOutlineQuietlyInner(allowed, "M3.4：后台维护（LLM）", true);', 1)
write(p, t)
print('coordinator race fixed')

# 3. host: GAME_STORAGE_LAYOUT constant + comment placement + old-world hint
p = 'src/hosts/local-web/local-web-host.ts'
t = read(p)
t = t.replace('import { DEFAULT_GAMES_ROOT } from "../../bootstrap/create-runtime-application.js";',
              '''import { DEFAULT_GAMES_ROOT } from "../../bootstrap/create-runtime-application.js";
import { GAME_STORAGE_LAYOUT } from "../../core/graph/ids.js";''', 1)
t = t.replace('      path.join(gamesRootForWorldHint(), DEFAULT_GAMES_ROOT, gameId, "outline.json"),',
              '''      path.join(gamesRootForWorldHint(), DEFAULT_GAMES_ROOT, gameId, GAME_STORAGE_LAYOUT.outline),''', 1)
# also count any content dir as a world (old worlds without outline)
old = '''  /** 是否已有可玩世界（当前 app 的世界大纲已落盘）。 */
  private hasWorld(): boolean {
    const gameId = this.app.gameId;
    if (gameId === undefined) return false;
    return existsSync(
      path.join(gamesRootForWorldHint(), DEFAULT_GAMES_ROOT, gameId, GAME_STORAGE_LAYOUT.outline),
    );
  }'''
new = '''  /** 是否已有可玩世界（大纲或任何图记录已落盘；旧世界无大纲也视为有）。 */
  private hasWorld(): boolean {
    const gameId = this.app.gameId;
    if (gameId === undefined) return false;
    const gameDir = path.join(gamesRootForWorldHint(), DEFAULT_GAMES_ROOT, gameId);
    return (
      existsSync(path.join(gameDir, GAME_STORAGE_LAYOUT.outline)) ||
      existsSync(path.join(gameDir, GAME_STORAGE_LAYOUT.decisions))
    );
  }'''
assert old in t
t = t.replace(old, new, 1)
# comment placement fix
t = t.replace('''/** 「继续游戏」探测根：与 entrypoint 的 cwd 约定一致（不引 Node 专属状态）。 */
function gamesRootForWorldHint(): string {
  return process.cwd();
}

function findProjectRoot(): string {''', '''function gamesRootForWorldHint(): string {
  return process.cwd();
}

function findProjectRoot(): string {''', 1)
t = t.replace('''/**
 * Walk up from this module until a directory containing package.json is
 * found.''', '''/** 「继续游戏」探测根：与 entrypoint 的 cwd 约定一致（不引 Node 专属状态）。 */
function gamesRootForWorldHintComment(): void {}

/**
 * Walk up from this module until a directory containing package.json is
 * found.''', 1)
write(p, t)
print('host hasWorld/layout fixed')

# 4. world-generator: drop redundant load; cli import merge; prompts as; test rmSync
p = 'src/application/world/world-generator.ts'
t = read(p)
t = t.replace('''    const store = new OutlineStore(this.gamesRoot, gameId);
    await store.load();

    const draft''', '''    const store = new OutlineStore(this.gamesRoot, gameId);

    const draft''', 1)
write(p, t)
print('world-generator load dropped')

p = 'src/entrypoints/cli.ts'
t = read(p)
t = t.replace('''import "dotenv/config";
import { loadConfig } from "../config.js";''', '''import "dotenv/config";
import { loadConfig, loadApiKey, type AppConfig } from "../config.js";''', 1)
t = t.replace('import type { AppConfig } from "../config.js";\n', '', 1)
t = t.replace('import { loadApiKey } from "../config.js";\n', '', 1)
write(p, t)
print('cli imports merged')

p = 'src/prompts.ts'
t = read(p)
t = t.replace('const instructions = InstructionSetSchema.parse(parsed) as InstructionSet;',
              'const instructions = InstructionSetSchema.parse(parsed);', 1)
write(p, t)
print('prompts as removed')

p = 'src/hosts/local-web/local-web-host.test.ts'
t = read(p)
t = t.replace('    rmSync(path.join(tmpdir(), "web-dist-"), { recursive: true, force: true });',
              '    rmSync(distDir, { recursive: true, force: true });', 1)
write(p, t)
print('test rmSync fixed')
