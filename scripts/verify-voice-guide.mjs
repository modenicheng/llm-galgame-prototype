// Verifies the collaborator guide covers every required section and that
// the README link resolves. Run in CI or locally before merge.
import { readFile, access } from "node:fs/promises";

const GUIDE = "docs/agents/TTS-音色配置指南.md";
const REQUIRED_SECTIONS = [
  "系统音色",
  "声音复刻",
  "声音设计",
  "voice-id",
  "voices.yaml",
  "voice_revision",
  "instruction_mode",
  "fixed_emotion",
  "你说话的情感是",
  "longanyang",
  "北京",
  "排错",
];

const guide = await readFile(GUIDE, "utf8");
const missing = REQUIRED_SECTIONS.filter((s) => !guide.includes(s));
if (missing.length > 0) {
  console.error(`guide missing sections: ${missing.join(", ")}`);
  process.exit(1);
}

const readme = await readFile("README.md", "utf8");
if (!readme.includes("TTS-音色配置指南.md")) {
  console.error("README.md does not link the voice guide");
  process.exit(1);
}

await access(GUIDE); // throws if the file does not exist
console.log("voice guide OK");
