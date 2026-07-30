import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROTOCOL = "growthlog-connector";
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const pairings = new Map();

let connector;
let tray;
let statusWindow;
let pendingDeepLink = "";
let isQuitting = false;

function pairingFilePath() {
  return path.join(app.getPath("userData"), "paired-sites.json");
}

function isValidPairing(origin, token) {
  try {
    const url = new URL(origin);
    const allowedProtocol = url.protocol === "https:"
      || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
    return allowedProtocol && /^[0-9a-f-]{36}$/i.test(token);
  } catch {
    return false;
  }
}

async function loadPairings() {
  try {
    const entries = JSON.parse(await readFile(pairingFilePath(), "utf8"));
    if (!Array.isArray(entries)) return;
    for (const [origin, token] of entries) {
      if (isValidPairing(origin, token)) pairings.set(origin, token);
    }
  } catch {
    // The file is created after the first approved connection.
  }
}

async function savePairings() {
  await writeFile(
    pairingFilePath(),
    JSON.stringify([...pairings.entries()], null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
}

function findDeepLink(args) {
  return args.find((value) => value.startsWith(`${PROTOCOL}://`)) ?? "";
}

async function handleDeepLink(value) {
  if (!value || !app.isReady()) {
    pendingDeepLink = value;
    return;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return;
  }

  const origin = url.searchParams.get("origin") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (url.hostname !== "pair" || !isValidPairing(origin, token)) {
    await dialog.showMessageBox({
      type: "error",
      title: "연결 요청 오류",
      message: "운영 프로그램의 연결 요청을 확인할 수 없습니다.",
    });
    return;
  }

  const result = await dialog.showMessageBox({
    type: "question",
    buttons: ["연결 허용", "취소"],
    defaultId: 0,
    cancelId: 1,
    title: "운영 프로그램 연결",
    message: `${origin} 사이트의 방송대 자동화 연결을 허용할까요?`,
    detail: "허용한 사이트만 이 컴퓨터의 Growth Log 연결 앱에 자동화 작업을 요청할 수 있습니다.",
    noLink: true,
  });
  if (result.response !== 0) return;

  pairings.set(origin, token);
  await savePairings();
  tray?.setToolTip("Growth Log 연결 앱 · 연결됨");
  await dialog.showMessageBox({
    type: "info",
    title: "연결 완료",
    message: "운영 프로그램 연결을 허용했습니다.",
    detail: "브라우저로 돌아가면 연결 상태가 자동으로 갱신됩니다.",
  });
}

function showStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.show();
    statusWindow.focus();
    return;
  }

  statusWindow = new BrowserWindow({
    width: 420,
    height: 430,
    minWidth: 380,
    minHeight: 390,
    title: "Growth Log 연결 앱",
    resizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  statusWindow.removeMenu();
  void statusWindow.loadFile(path.join(currentDirectory, "status.html"));
  statusWindow.on("closed", () => {
    statusWindow = undefined;
  });
}

async function openAutomationLogin() {
  try {
    await connector?.openLogin();
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "Chrome 실행 오류",
      message: "방송대 로그인 창을 열지 못했습니다.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function openTistoryDashboard() {
  const url = connector?.dashboardUrl ?? "http://127.0.0.1:4317/";
  try {
    await shell.openExternal(url);
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "자동화 화면 열기 오류",
      message: "티스토리 임시저장 화면을 열지 못했습니다.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function rebuildTrayMenu() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: "티스토리 임시저장 열기", click: () => void openTistoryDashboard() },
    { label: "연결 상태 보기", click: showStatusWindow },
    { label: "방송대 로그인 창 열기", click: () => void openAutomationLogin() },
    { type: "separator" },
    {
      label: "컴퓨터 시작 시 자동 실행",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        rebuildTrayMenu();
      },
    },
    {
      label: "연결된 사이트 초기화",
      click: async () => {
        const result = await dialog.showMessageBox({
          type: "warning",
          buttons: ["초기화", "취소"],
          defaultId: 1,
          cancelId: 1,
          message: "허용한 운영 프로그램 연결을 모두 초기화할까요?",
          noLink: true,
        });
        if (result.response !== 0) return;
        pairings.clear();
        await savePairings();
        tray?.setToolTip("Growth Log 연결 앱 · 연결 대기");
      },
    },
    { type: "separator" },
    {
      label: "종료",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray() {
  const trayIcon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAMUlEQVR42mNgGAXUB8Q/gPgfEP8H4n8YxP8xDPz/GRgYGP4zMDAwMDCQkJBgFIwCAAAw9wUjS2XvGQAAAABJRU5ErkJggg==",
  );
  if (process.platform === "darwin") trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip(pairings.size ? "Growth Log 연결 앱 · 연결됨" : "Growth Log 연결 앱 · 연결 대기");
  tray.on("click", showStatusWindow);
  rebuildTrayMenu();
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, args) => {
    const deepLink = findDeepLink(args);
    if (deepLink) void handleDeepLink(deepLink);
    else void openTistoryDashboard();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    void handleDeepLink(url);
  });

  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  void app.whenReady().then(async () => {
    await loadPairings();
    let connectorStartError;
    try {
      const { startKnouHelper } = await import("../generated/knou-helper.mjs");
      connector = await startKnouHelper({
        profileDir: path.join(app.getPath("userData"), "knou-playwright-profile"),
        isPairedOrigin: (origin, token) => pairings.get(origin) === token,
        quiet: true,
      });
    } catch (error) {
      connectorStartError = error;
      console.error("Growth Log connector failed to start:", error);
    }
    createTray();

    if (connectorStartError) {
      await dialog.showMessageBox({
        type: "error",
        title: "연결 앱 시작 오류",
        message: "로컬 자동화 서비스를 시작하지 못했습니다.",
        detail: connectorStartError instanceof Error ? connectorStartError.message : String(connectorStartError),
      });
    }

    const initialDeepLink = pendingDeepLink || findDeepLink(process.argv);
    if (initialDeepLink) void handleDeepLink(initialDeepLink);
    else void openTistoryDashboard();

    app.on("activate", showStatusWindow);
    app.on("window-all-closed", () => {
      // Keep the connector available in the tray.
    });
    app.on("before-quit", (event) => {
      if (isQuitting || !connector) return;
      event.preventDefault();
      isQuitting = true;
      void connector.close().finally(() => app.quit());
    });
  }).catch(async (error) => {
    console.error("Growth Log connector app failed to initialize:", error);
    await dialog.showMessageBox({
      type: "error",
      title: "연결 앱 시작 오류",
      message: "Growth Log 연결 앱을 시작하지 못했습니다.",
      detail: error instanceof Error ? error.message : String(error),
    });
    app.quit();
  });
}
