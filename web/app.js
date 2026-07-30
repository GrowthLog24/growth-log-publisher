const state = {
  jobs: [],
  busy: false,
};

const element = (id) => document.getElementById(id);
const htmlEscape = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

function addLog(message, kind = "info") {
  const log = element("log");
  log.querySelector(".empty")?.remove();
  const row = document.createElement("div");
  row.className = `log-entry ${kind}`;
  const now = new Date();
  row.innerHTML = `<time>${now.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time><p>${htmlEscape(message)}</p>`;
  log.prepend(row);
}

async function api(path, body = undefined) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({ ok: false, message: `HTTP ${response.status}` }));
  if (!response.ok) {
    const error = new Error(result.message || "작업에 실패했습니다.");
    error.result = result;
    throw error;
  }
  return result;
}

function splitTags(value) {
  const candidates = Array.isArray(value) ? value : String(value ?? "").split(/[\n,]+/);
  return [...new Set(candidates.map((tag) => String(tag).trim().replace(/^#+/, "")).filter(Boolean))].slice(0, 10);
}

function inlineMarkdown(value) {
  let text = htmlEscape(value);
  const code = [];
  text = text.replace(/`([^`]+)`/g, (_match, content) => {
    code.push(content);
    return `\u0000CODE${code.length - 1}\u0000`;
  });
  text = text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return text.replace(/\u0000CODE(\d+)\u0000/g, (_match, index) => `<code>${htmlEscape(code[Number(index)])}</code>`);
}

function markdownImage(line) {
  const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/.exec(line.trim());
  const captionedLink = /^\[([^\]]+)\]\(([^)\s]+)\)\s*$/.exec(line.trim());
  const match = image || (
    captionedLink && (/^growthlog-asset:\/\//.test(captionedLink[2]) || /\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(captionedLink[2]))
      ? captionedLink
      : null
  );
  if (!match) return "";
  const caption = htmlEscape(match[1]);
  const source = htmlEscape(match[2]);
  return `<figure data-ke-type="image"><img src="${source}" alt="${caption}" />${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;
}

function markdownToHtml(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let paragraph = [];
  let listType = "";
  let codeFence = false;
  let codeLines = [];
  let tableBuffer = [];

  const flushParagraph = () => {
    if (paragraph.length) output.push(`<p>${paragraph.map(inlineMarkdown).join("<br />")}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = "";
  };
  const flushTable = () => {
    if (tableBuffer.length < 2) {
      paragraph.push(...tableBuffer);
      tableBuffer = [];
      return;
    }
    const rows = tableBuffer.map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
    const isDivider = rows[1].every((cell) => /^:?-{3,}:?$/.test(cell));
    if (!isDivider) {
      paragraph.push(...tableBuffer);
      tableBuffer = [];
      return;
    }
    output.push("<table><thead><tr>");
    output.push(rows[0].map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join(""));
    output.push("</tr></thead><tbody>");
    for (const row of rows.slice(2)) output.push(`<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`);
    output.push("</tbody></table>");
    tableBuffer = [];
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      flushParagraph();
      closeList();
      flushTable();
      if (codeFence) {
        output.push(`<pre><code>${htmlEscape(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
      }
      codeFence = !codeFence;
      continue;
    }
    if (codeFence) {
      codeLines.push(line);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      closeList();
      tableBuffer.push(line);
      continue;
    }
    flushTable();
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    const image = markdownImage(line);
    if (image) {
      flushParagraph();
      closeList();
      output.push(image);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length + 1, 6);
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      closeList();
      output.push(`<blockquote><p>${inlineMarkdown(quote[1])}</p></blockquote>`);
      continue;
    }

    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) {
        closeList();
        output.push(`<${nextType}>`);
        listType = nextType;
      }
      output.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      continue;
    }

    if (/^\s*<(?:p|div|figure|img|table|ul|ol|h[1-6]|blockquote|hr)\b/i.test(line)) {
      flushParagraph();
      closeList();
      output.push(line);
      continue;
    }
    paragraph.push(line.trim());
  }

  flushTable();
  flushParagraph();
  closeList();
  if (codeFence && codeLines.length) output.push(`<pre><code>${htmlEscape(codeLines.join("\n"))}</code></pre>`);
  return output.join("\n");
}

function posixNormalize(pathname) {
  const parts = [];
  for (const part of pathname.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function directoryOf(pathname) {
  const normalized = posixNormalize(pathname);
  return normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/") + 1) : "";
}

function mimeForPath(pathname) {
  const extension = pathname.toLowerCase().split(".").pop();
  return {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  }[extension] || "";
}

function extractDocument(markdown, filename) {
  let text = String(markdown).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let frontmatter = "";
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end >= 0) {
      frontmatter = text.slice(4, end);
      text = text.slice(end + 5);
    }
  }

  const titleMatch = text.match(/^#\s+(.+)$/m);
  const frontTitle = frontmatter.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1];
  const title = (frontTitle || titleMatch?.[1] || filename.split("/").pop().replace(/\.md$/i, "").replace(/[_-]+/g, " ")).trim();
  if (titleMatch) text = text.replace(titleMatch[0], "").trimStart();

  const tags = [];
  const frontTags = frontmatter.match(/^tags:\s*(.+)$/m)?.[1] || "";
  tags.push(...frontTags.replace(/^\[|\]$/g, "").split(","));
  for (const line of text.split("\n")) {
    if (!/^\s*(?:#[^\s#]+\s*)+$/.test(line)) continue;
    tags.push(...[...line.matchAll(/#([^\s#]+)/g)].map((match) => match[1]));
  }
  text = text.split("\n").filter((line) => !/^\s*(?:#[^\s#]+\s*)+$/.test(line)).join("\n");
  return { title, markdown: text, tags: splitTags(tags) };
}

async function zipJobs(file) {
  if (!window.JSZip) throw new Error("ZIP 처리 라이브러리를 불러오지 못했습니다.");
  const archive = await window.JSZip.loadAsync(file);
  const entries = new Map();
  archive.forEach((relativePath, entry) => {
    const normalized = posixNormalize(relativePath);
    if (!entry.dir && normalized && !normalized.startsWith("__MACOSX/") && !normalized.split("/").some((part) => part.startsWith("."))) {
      entries.set(normalized, entry);
    }
  });

  const excludes = element("exclude-keywords").value.split(",").map((word) => word.trim().toLowerCase()).filter(Boolean);
  const markdownPaths = [...entries.keys()]
    .filter((pathname) => /\.md$/i.test(pathname))
    .filter((pathname) => !excludes.some((keyword) => pathname.toLowerCase().includes(keyword)))
    .sort((a, b) => a.localeCompare(b, "ko"));
  if (markdownPaths.length === 0) throw new Error("ZIP 안에서 등록할 Markdown 파일을 찾지 못했습니다.");
  if (markdownPaths.length > 30) throw new Error("한 번에 처리할 수 있는 글은 최대 30개입니다.");

  const jobs = [];
  for (const markdownPath of markdownPaths) {
    const raw = await entries.get(markdownPath).async("string");
    const document = extractDocument(raw, markdownPath);
    const attachments = [];
    const replacements = new Map();
    const referencePattern = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    for (const match of document.markdown.matchAll(referencePattern)) {
      let reference = match[2].replace(/^<|>$/g, "");
      try {
        reference = decodeURIComponent(reference);
      } catch {
        // Keep a path containing a literal percent sign as written.
      }
      if (/^(?:https?:|data:)/i.test(reference)) continue;
      const resolved = posixNormalize(`${directoryOf(markdownPath)}${reference}`);
      const entry = entries.get(resolved);
      const mime = mimeForPath(resolved);
      if (!entry || !mime || replacements.has(reference)) continue;
      const id = `asset-${jobs.length + 1}-${attachments.length + 1}`;
      const base64 = await entry.async("base64");
      attachments.push({
        id,
        name: resolved.split("/").pop(),
        dataUrl: `data:${mime};base64,${base64}`,
      });
      replacements.set(reference, `growthlog-asset://${id}`);
    }

    let markdownWithAssets = document.markdown;
    for (const [reference, placeholder] of replacements) {
      markdownWithAssets = markdownWithAssets.split(reference).join(placeholder);
      markdownWithAssets = markdownWithAssets.split(encodeURI(reference)).join(placeholder);
    }
    jobs.push({
      source: markdownPath,
      title: document.title,
      html: markdownToHtml(markdownWithAssets),
      tags: document.tags,
      attachments,
      status: "ready",
    });
  }
  return jobs;
}

function renderJobs() {
  const list = element("job-list");
  list.replaceChildren();
  for (let index = 0; index < state.jobs.length; index += 1) {
    const job = state.jobs[index];
    const item = document.createElement("li");
    item.className = `job ${job.status || "ready"}`;
    item.dataset.index = String(index);
    const label = {
      ready: "대기",
      running: "처리 중",
      done: "저장 완료",
      failed: "확인 필요",
    }[job.status] || "대기";
    item.innerHTML = `
      <span class="job-index">${String(index + 1).padStart(2, "0")}</span>
      <div><strong>${htmlEscape(job.title)}</strong><small>${htmlEscape(job.source)} · 이미지 ${job.attachments.length}개 · 태그 ${job.tags.length}개</small></div>
      <span class="job-state">${label}</span>
    `;
    list.append(item);
  }
  element("zip-count").textContent = `${state.jobs.length}개 글`;
  element("image-count").textContent = `${state.jobs.reduce((sum, job) => sum + job.attachments.length, 0)}개`;
  element("zip-summary").classList.toggle("hidden", state.jobs.length === 0);
}

function commonFields() {
  return {
    blogUrl: element("blog-url").value.trim(),
    category: element("category").value.trim(),
  };
}

async function withButton(button, task) {
  if (state.busy) return;
  state.busy = true;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "처리 중…";
  try {
    await task();
  } catch (error) {
    addLog(error.message || String(error), "error");
  } finally {
    state.busy = false;
    button.disabled = false;
    button.textContent = original;
  }
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === tab.dataset.panel));
  });
}

element("open-login").addEventListener("click", (event) => withButton(event.currentTarget, async () => {
  const result = await api("/tistory/login", { blogUrl: element("blog-url").value.trim() });
  addLog(result.message);
}));

element("zip-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  state.jobs = [];
  renderJobs();
  if (!file) return;
  element("zip-name").textContent = file.name;
  try {
    state.jobs = await zipJobs(file);
    renderJobs();
    addLog(`${file.name}에서 글 ${state.jobs.length}개와 연결 이미지 ${state.jobs.reduce((sum, job) => sum + job.attachments.length, 0)}개를 확인했습니다.`);
  } catch (error) {
    addLog(error.message || String(error), "error");
  }
});

element("exclude-keywords").addEventListener("change", () => {
  if (element("zip-file").files?.length) element("zip-file").dispatchEvent(new Event("change"));
});

element("save-zip").addEventListener("click", (event) => withButton(event.currentTarget, async () => {
  if (!state.jobs.length) throw new Error("먼저 ZIP 파일을 선택해 주세요.");
  const shared = commonFields();
  if (!shared.blogUrl) throw new Error("티스토리 블로그 주소를 입력해 주세요.");
  addLog(`${state.jobs.length}개 글의 임시저장을 시작합니다.`);

  for (let index = 0; index < state.jobs.length; index += 1) {
    const job = state.jobs[index];
    if (job.status === "done") continue;
    job.status = "running";
    renderJobs();
    try {
      const result = await api("/tistory/draft", {
        ...shared,
        title: job.title,
        html: job.html,
        tags: job.tags,
        attachments: job.attachments,
      });
      job.status = "done";
      addLog(`[${index + 1}/${state.jobs.length}] ${job.title} — ${result.message}`);
    } catch (error) {
      job.status = "failed";
      addLog(`[${index + 1}/${state.jobs.length}] ${job.title} — ${error.message}`, "error");
      if (error.result?.code === "TISTORY_LOGIN_REQUIRED") break;
    }
    renderJobs();
  }
}));

element("save-single").addEventListener("click", (event) => withButton(event.currentTarget, async () => {
  const body = element("single-body").value;
  const result = await api("/tistory/draft", {
    ...commonFields(),
    title: element("single-title").value.trim(),
    html: element("single-format").value === "html" ? body : markdownToHtml(body),
    tags: splitTags(element("single-tags").value),
  });
  addLog(`${element("single-title").value.trim()} — ${result.message}`);
}));

element("prepare-modify").addEventListener("click", (event) => withButton(event.currentTarget, async () => {
  const body = element("modify-body").value;
  const result = await api("/tistory/modify", {
    ...commonFields(),
    postUrl: element("modify-url").value.trim(),
    title: element("modify-title").value.trim(),
    html: element("modify-format").value === "html" ? body : markdownToHtml(body),
    tags: splitTags(element("modify-tags").value),
  });
  addLog(`${element("modify-title").value.trim()} — ${result.message}`);
}));

element("clear-log").addEventListener("click", () => {
  element("log").innerHTML = '<p class="empty">아직 실행한 작업이 없습니다.</p>';
});

async function checkHealth() {
  const connection = element("connection");
  try {
    const health = await api("/health");
    connection.className = "connection online";
    connection.querySelector("span").textContent = health.browserOpen ? "전용 Chrome 연결됨" : "자동화 준비됨";
  } catch {
    connection.className = "connection error";
    connection.querySelector("span").textContent = "연결 오류";
  }
}

void checkHealth();
setInterval(checkHealth, 10_000);
