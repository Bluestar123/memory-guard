import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

type TopApp = {
  pid: number;
  name: string;
  display_name: string;
  memory_label: string;
  can_quit: boolean;
  protection_reason: string | null;
  recommendation: string;
  kind: "process" | "chrome_group";
  renderer_count: number | null;
};

type MemorySummary = {
  percentage: number;
  used_bytes: number;
  total_bytes: number;
  used_label: string;
  total_label: string;
  updated_at_ms: number;
};

type SelfMemorySummary = {
  memory_bytes: number;
  memory_label: string;
};

type AlertSettings = {
  threshold_percent: number;
  refresh_interval_secs: number;
  cooldown_secs: number;
  top_apps_limit: number;
  language: "zh" | "en";
};

type DraftSettings = {
  threshold_percent: string;
  refresh_interval_secs: string;
  cooldown_secs: string;
  top_apps_limit: string;
  language: "zh" | "en";
};

type TabId = "overview" | "settings" | "feedback";
type NotificationPermission = "granted" | "denied" | "prompt" | "prompt-with-rationale";
type NotificationDeliveryTarget = "app" | "terminal";
type NotificationPermissionResult = {
  permission: NotificationPermission;
  test_notification_sent: boolean;
  error: string | null;
};

const initialMemory: MemorySummary = {
  percentage: 0,
  used_bytes: 0,
  total_bytes: 0,
  used_label: "Waiting",
  total_label: "Waiting",
  updated_at_ms: 0
};

const initialSelfMemory: SelfMemorySummary = {
  memory_bytes: 0,
  memory_label: "--"
};

const initialAlertSettings: AlertSettings = {
  threshold_percent: 90,
  refresh_interval_secs: 2,
  cooldown_secs: 300,
  top_apps_limit: 10,
  language: "zh"
};

const emailAddress = "aaron187127@gmail.com";

function toDraftSettings(settings: AlertSettings): DraftSettings {
  return {
    threshold_percent: String(settings.threshold_percent),
    refresh_interval_secs: String(settings.refresh_interval_secs),
    cooldown_secs: String(settings.cooldown_secs),
    top_apps_limit: String(settings.top_apps_limit),
    language: settings.language
  };
}

function parseBoundedInteger(value: string, min: number, max: number, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a whole number.`);
  }

  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }

  return parsed;
}

function normalizeIntegerInput(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits === "") {
    return "";
  }

  return String(Number(digits));
}

function toActiveSettings(settings: DraftSettings): AlertSettings {
  return {
    threshold_percent: parseBoundedInteger(settings.threshold_percent, 1, 100, "Threshold"),
    refresh_interval_secs: parseBoundedInteger(settings.refresh_interval_secs, 1, 60, "Refresh interval"),
    cooldown_secs: parseBoundedInteger(settings.cooldown_secs, 30, 86400, "Cooldown"),
    top_apps_limit: parseBoundedInteger(settings.top_apps_limit, 3, 20, "Top apps count"),
    language: settings.language
  };
}

function initialTab(): TabId {
  const tab = new URLSearchParams(window.location.search).get("tab");
  return tab === "settings" || tab === "feedback" || tab === "overview" ? tab : "overview";
}

const copy = {
  zh: {
    overview: "概览",
    settings: "设置",
    feedback: "反馈",
    memory: "内存",
    appMemory: "本应用占用",
    used: "已用",
    healthy: "当前状态正常",
    warning: "内存压力较高",
    topApps: "内存占用排行",
    quit: "退出",
    protected: "受保护",
    originalName: "进程",
    threshold: "提醒阈值",
    refresh: "刷新间隔",
    cooldown: "提醒冷却",
    topCount: "显示数量",
    language: "语言",
    save: "保存设置",
    updates: "检查更新",
    install: "安装更新并重启",
    manualUpdates: "更新需要手动确认",
    noUpdate: "当前已是最新版本",
    checking: "正在检查更新",
    updateAvailable: "发现新版本",
    updateCheckFailed: "检查更新失败",
    installingUpdate: "正在安装更新",
    downloadingUpdate: "正在下载安装包",
    updateInstalledRestarting: "更新已安装，正在重启",
    emailTitle: "欢迎反馈使用体验",
    emailHelp: "目前只支持邮箱反馈。请描述你遇到的问题、内存占用截图或希望优化的应用名称。",
    emailSubject: "Memory Guard 反馈",
    emailBody: "你好，我想反馈：",
    cancel: "取消",
    quitApp: "退出应用",
    forceQuit: "强制退出",
    quitTitle: "退出这个应用？",
    quitHelp: "优先使用正常退出。只有应用卡住或正常退出无效时，再使用强制退出。",
    panelClosed: "面板关闭时不扫描应用",
    selfMemoryUnavailable: "暂时无法读取",
    scanError: "无法扫描应用",
    emptyApps: "暂时没有应用数据",
    saved: "设置已保存",
    notifications: "系统通知",
    enableNotifications: "启用通知",
    testNotifications: "发送测试通知",
    testNotificationSent: "测试通知已发送。如果没有看到横幅，请检查系统设置里的通知样式或勿扰模式。",
    notificationCannotDisable: "关闭通知需要在系统设置 > 通知 > Memory Guard 中操作。",
    notificationGranted: "通知已启用。",
    notificationDenied: "通知被 macOS 拒绝，请在系统设置的通知里允许 Memory Guard。",
    notificationPrompt: "尚未启用通知，超过阈值时可能无法及时提醒你打开面板查看详情。",
    notificationDevTarget:
      "当前是开发模式，macOS 会把测试通知归到 Terminal。若没弹窗，请在系统设置 > 通知里允许 Terminal 横幅；打包后再允许 Memory Guard。",
    chromeSubtitle: "包含多个标签页和页面渲染进程",
    chromeRendererTitle: "Chrome 渲染进程",
    chromeRendererCount: "个渲染进程",
    chromeRendererHelp:
      "可能对应某个标签页、页面内容、iframe 或扩展进程。后续版本将支持识别更具体的标签页名称。",
    chromeTabAdvice: "建议先关闭未使用的标签页，不建议直接操作底层渲染进程。",
    closeTabsFirst: "先关标签页"
  },
  en: {
    overview: "Overview",
    settings: "Settings",
    feedback: "Feedback",
    memory: "Memory",
    appMemory: "App memory",
    used: "Used",
    healthy: "Memory looks normal",
    warning: "Memory pressure is high",
    topApps: "Top memory apps",
    quit: "Quit",
    protected: "Protected",
    originalName: "Process",
    threshold: "Alert threshold",
    refresh: "Refresh interval",
    cooldown: "Alert cooldown",
    topCount: "List count",
    language: "Language",
    save: "Save settings",
    updates: "Check for updates",
    install: "Install update and restart",
    manualUpdates: "Updates require confirmation",
    noUpdate: "Memory Guard is up to date",
    checking: "Checking for updates",
    updateAvailable: "Update available",
    updateCheckFailed: "Could not check for updates",
    installingUpdate: "Installing update",
    downloadingUpdate: "Downloading update",
    updateInstalledRestarting: "Update installed. Restarting",
    emailTitle: "Send feedback",
    emailHelp: "Email feedback is supported for now. Include what happened, screenshots, or apps you want improved.",
    emailSubject: "Memory Guard feedback",
    emailBody: "Hi, I want to report:",
    cancel: "Cancel",
    quitApp: "Quit app",
    forceQuit: "Force quit",
    quitTitle: "Quit this app?",
    quitHelp: "Normal quit is safer. Use force quit only if the app is stuck.",
    panelClosed: "App scanning stops while the panel is closed",
    selfMemoryUnavailable: "Unavailable right now",
    scanError: "Could not scan apps",
    emptyApps: "No app data yet",
    saved: "Settings saved",
    notifications: "System notifications",
    enableNotifications: "Enable notifications",
    testNotifications: "Send test notification",
    testNotificationSent:
      "Test notification sent. If no banner appears, check the notification style or Focus mode in System Settings.",
    notificationCannotDisable:
      "Turn off notifications in System Settings > Notifications > Memory Guard.",
    notificationGranted: "Notifications are enabled.",
    notificationDenied: "macOS denied notifications. Allow Memory Guard in System Settings > Notifications.",
    notificationPrompt:
      "Notifications are not enabled yet, so you may miss alerts that tell you to open the panel for details.",
    notificationDevTarget:
      "This is dev mode, so macOS attributes test notifications to Terminal. If no banner appears, allow Terminal banners in System Settings > Notifications; packaged builds use Memory Guard.",
    chromeSubtitle: "Includes multiple tabs and page renderer processes",
    chromeRendererTitle: "Chrome renderer processes",
    chromeRendererCount: "renderer processes",
    chromeRendererHelp:
      "A renderer can map to a tab, page content, iframe, or extension process. A later version will identify specific tab names.",
    chromeTabAdvice: "Close unused tabs first. Direct renderer actions are not recommended.",
    closeTabsFirst: "Close tabs first"
  }
};

function App() {
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const [memory, setMemory] = useState<MemorySummary>(initialMemory);
  const [activeSettings, setActiveSettings] = useState<AlertSettings>(initialAlertSettings);
  const [draftSettings, setDraftSettings] = useState<DraftSettings>(
    toDraftSettings(initialAlertSettings)
  );
  const [settingsStatus, setSettingsStatus] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [selfMemory, setSelfMemory] = useState<SelfMemorySummary>(initialSelfMemory);
  const [topApps, setTopApps] = useState<TopApp[]>([]);
  const [appsStatus, setAppsStatus] = useState(copy.zh.panelClosed);
  const [selectedApp, setSelectedApp] = useState<TopApp | null>(null);
  const [terminationStatus, setTerminationStatus] = useState("");
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [updateStatus, setUpdateStatus] = useState(copy.zh.manualUpdates);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermission>("prompt");
  const [notificationDeliveryTarget, setNotificationDeliveryTarget] =
    useState<NotificationDeliveryTarget>("app");

  const t = copy[activeSettings.language];
  const isWaiting = memory.updated_at_ms === 0;
  const isHigh = !isWaiting && memory.percentage >= activeSettings.threshold_percent;

  const emailHref = useMemo(() => {
    const subject = encodeURIComponent(t.emailSubject);
    const body = encodeURIComponent(t.emailBody);
    return `mailto:${emailAddress}?subject=${subject}&body=${body}`;
  }, [t.emailBody, t.emailSubject]);

  useEffect(() => {
    let isMounted = true;

    invoke<MemorySummary>("latest_memory_summary")
      .then((summary) => {
        if (isMounted) {
          setMemory(summary);
        }
      })
      .catch(() => {
        if (isMounted) {
          setMemory(initialMemory);
        }
      });

    invoke<AlertSettings>("alert_settings")
      .then((nextSettings) => {
        if (isMounted) {
          setActiveSettings(nextSettings);
          setDraftSettings(toDraftSettings(nextSettings));
          setAppsStatus(copy[nextSettings.language].panelClosed);
          setUpdateStatus(copy[nextSettings.language].manualUpdates);
        }
      })
      .catch(() => {
        if (isMounted) {
          setActiveSettings(initialAlertSettings);
          setDraftSettings(toDraftSettings(initialAlertSettings));
        }
      });

    invoke<boolean>("is_panel_open")
      .then((isOpen) => {
        if (isMounted) {
          setPanelOpen(isOpen);
        }
      })
      .catch(() => {
        if (isMounted) {
          setPanelOpen(false);
        }
      });

    invoke<NotificationPermission>("notification_permission_state")
      .then((permission) => {
        if (isMounted) {
          setNotificationPermission(permission);
        }
      })
      .catch(() => {
        if (isMounted) {
          setNotificationPermission("denied");
        }
      });

    invoke<NotificationDeliveryTarget>("notification_delivery_target")
      .then((target) => {
        if (isMounted) {
          setNotificationDeliveryTarget(target);
        }
      })
      .catch(() => {
        if (isMounted) {
          setNotificationDeliveryTarget("app");
        }
      });

    const unlisten = listen<MemorySummary>("memory-summary-updated", (event) => {
      setMemory(event.payload);
    });

    const unlistenPanel = listen<boolean>("panel-visibility-changed", (event) => {
      setPanelOpen(event.payload);
    });

    const unlistenTab = listen<TabId>("panel-tab-requested", (event) => {
      if (
        event.payload === "overview" ||
        event.payload === "settings" ||
        event.payload === "feedback"
      ) {
        setActiveTab(event.payload);
      }
    });

    return () => {
      isMounted = false;
      unlisten.then((stopListening) => stopListening());
      unlistenPanel.then((stopListening) => stopListening());
      unlistenTab.then((stopListening) => stopListening());
    };
  }, []);

  useEffect(() => {
    if (!panelOpen || activeTab !== "overview") {
      setAppsStatus(t.panelClosed);
      return;
    }

    let isActive = true;

    async function refreshTopApps() {
      try {
        const apps = await invoke<TopApp[]>("top_apps");
        if (isActive) {
          setTopApps(apps);
          setAppsStatus(apps.length === 0 ? t.emptyApps : `${t.topApps} · ${apps.length}`);
        }
      } catch {
        if (isActive) {
          setAppsStatus(t.scanError);
        }
      }
    }

    refreshTopApps();
    const intervalId = window.setInterval(refreshTopApps, 3000);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, [activeTab, panelOpen, t.emptyApps, t.panelClosed, t.scanError, t.topApps]);

  useEffect(() => {
    if (!panelOpen || activeTab !== "overview") {
      return;
    }

    let isActive = true;

    async function refreshSelfMemory() {
      try {
        const summary = await invoke<SelfMemorySummary>("self_memory_summary");
        if (isActive) {
          setSelfMemory(summary);
        }
      } catch {
        if (isActive) {
          setSelfMemory({
            memory_bytes: 0,
            memory_label: t.selfMemoryUnavailable
          });
        }
      }
    }

    refreshSelfMemory();
    const intervalId = window.setInterval(refreshSelfMemory, 3000);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, [activeTab, panelOpen, t.selfMemoryUnavailable]);

  function updateSetting(field: keyof DraftSettings, value: string) {
    if (field === "language") {
      if (value !== "zh" && value !== "en") {
        return;
      }

      setDraftSettings((current) => ({
        ...current,
        language: value
      }));
      return;
    }

    setDraftSettings((current) => ({
      ...current,
      [field]: normalizeIntegerInput(value)
    }));
  }

  function notificationStatusText(permission: NotificationPermission): string {
    const devNote = notificationDeliveryTarget === "terminal" ? ` ${t.notificationDevTarget}` : "";

    if (permission === "granted") {
      return `${t.notificationGranted}${devNote}`;
    }

    if (permission === "denied") {
      return `${t.notificationDenied}${devNote}`;
    }

    return `${t.notificationPrompt}${devNote}`;
  }

  async function enableNotifications() {
    try {
      const result =
        await invoke<NotificationPermissionResult>("request_notification_permission");
      setNotificationPermission(result.permission);

      if (result.error) {
        setSettingsStatus(result.error);
      } else if (result.test_notification_sent) {
        setSettingsStatus(t.testNotificationSent);
      } else {
        setSettingsStatus(notificationStatusText(result.permission));
      }
    } catch (error) {
      setSettingsStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function toggleNotifications() {
    if (notificationPermission === "granted") {
      setSettingsStatus(t.notificationCannotDisable);
      await enableNotifications();
      return;
    }

    await enableNotifications();
  }

  async function saveSettings() {
    try {
      const normalizedSettings = toActiveSettings(draftSettings);
      const updated = await invoke<AlertSettings>("update_alert_settings", {
        input: normalizedSettings
      });
      setActiveSettings(updated);
      setDraftSettings(toDraftSettings(updated));
      setSettingsStatus(copy[updated.language].saved);
      setAppsStatus(copy[updated.language].panelClosed);
      setUpdateStatus(copy[updated.language].manualUpdates);
    } catch (error) {
      setSettingsStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function terminateSelectedApp(force: boolean) {
    if (!selectedApp) {
      return;
    }

    try {
      await invoke("terminate_app", {
        input: {
          pid: selectedApp.pid,
          force
        }
      });
      setTerminationStatus(
        force
          ? `Force quit requested for ${selectedApp.display_name}`
          : `Quit requested for ${selectedApp.display_name}`
      );
      setSelectedApp(null);
      const apps = await invoke<TopApp[]>("top_apps");
      setTopApps(apps);
    } catch (error) {
      setTerminationStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function checkForUpdates() {
    setAvailableUpdate(null);
    setUpdateStatus(t.checking);

    try {
      const update = await check();
      if (!update) {
        setUpdateStatus(t.noUpdate);
        return;
      }

      setAvailableUpdate(update);
      setUpdateStatus(`${t.updateAvailable}: ${update.version}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUpdateStatus(`${t.updateCheckFailed}: ${message}`);
    }
  }

  async function installAvailableUpdate() {
    if (!availableUpdate) {
      return;
    }

    const shouldInstall = window.confirm(
      `Install version ${availableUpdate.version} and restart Memory Guard?`
    );
    if (!shouldInstall) {
      return;
    }

    try {
      setUpdateStatus(`${t.installingUpdate}: ${availableUpdate.version}`);
      await availableUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setUpdateStatus(t.downloadingUpdate);
        }

        if (event.event === "Finished") {
          setUpdateStatus(t.updateInstalledRestarting);
        }
      });
      await relaunch();
    } catch (error) {
      setUpdateStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Memory Guard</p>
          <h1>{t.memory}</h1>
        </div>
        <strong className={isHigh ? "state-pill warning" : "state-pill"}>
          {isHigh ? t.warning : t.healthy}
        </strong>
      </header>

      <div className="workspace">
        <nav className="tabs" aria-label="Memory Guard">
          {(["overview", "settings", "feedback"] as TabId[]).map((tab) => (
            <button
              key={tab}
              type="button"
              className={activeTab === tab ? "tab active" : "tab"}
              onClick={() => setActiveTab(tab)}
            >
              {t[tab]}
            </button>
          ))}
        </nav>

        {activeTab === "overview" ? (
          <section className="tab-panel">
          <section className="summary">
            <div>
              <p className="eyebrow">{t.memory}</p>
              <h2>{isWaiting ? "--%" : `${memory.percentage}%`}</h2>
            </div>
            <div className="usage">
              <span>{t.used}</span>
              <strong>
                {memory.used_label} / {memory.total_label}
              </strong>
            </div>
            <div className="usage">
              <span>{t.appMemory}</span>
              <strong>{selfMemory.memory_label}</strong>
            </div>
          </section>

          <section className="panel-section" aria-labelledby="top-apps-heading">
            <div className="section-heading">
              <h3 id="top-apps-heading">{t.topApps}</h3>
              <span>{appsStatus}</span>
            </div>

            <ul className="app-list">
              {topApps.map((app, index) => {
                const isChromeGroup = app.kind === "chrome_group";

                return (
                  <li key={`${app.pid}-${index}`}>
                    <div className="app-row-main">
                      <strong>{app.display_name}</strong>
                      <span>
                        {isChromeGroup ? t.chromeSubtitle : `${t.originalName}: ${app.name}`}
                      </span>
                      {isChromeGroup ? (
                        <div className="chrome-renderer-note">
                          <strong>{t.chromeRendererTitle}</strong>
                          <span>
                            {app.renderer_count ?? 0} {t.chromeRendererCount}
                          </span>
                          <small>{t.chromeRendererHelp}</small>
                          <small>{t.chromeTabAdvice}</small>
                        </div>
                      ) : (
                        <small>{app.recommendation}</small>
                      )}
                    </div>
                    <p>{app.memory_label}</p>
                    <button
                      type="button"
                      className="quit-button"
                      disabled={!app.can_quit}
                      onClick={() => setSelectedApp(app)}
                    >
                      {isChromeGroup ? t.closeTabsFirst : app.can_quit ? t.quit : t.protected}
                    </button>
                  </li>
                );
              })}
            </ul>
            {terminationStatus ? <p className="status-text">{terminationStatus}</p> : null}
          </section>
          </section>
        ) : null}

        {activeTab === "settings" ? (
          <section className="tab-panel">
          <div className="settings-grid">
            <label>
              {t.threshold} %
              <input
                inputMode="numeric"
                min="1"
                max="100"
                pattern="[0-9]*"
                type="text"
                value={draftSettings.threshold_percent}
                onChange={(event) => updateSetting("threshold_percent", event.target.value)}
              />
            </label>
            <label>
              {t.refresh} sec
              <input
                inputMode="numeric"
                min="1"
                max="60"
                pattern="[0-9]*"
                type="text"
                value={draftSettings.refresh_interval_secs}
                onChange={(event) => updateSetting("refresh_interval_secs", event.target.value)}
              />
            </label>
            <label>
              {t.cooldown} sec
              <input
                inputMode="numeric"
                min="30"
                step="30"
                pattern="[0-9]*"
                type="text"
                value={draftSettings.cooldown_secs}
                onChange={(event) => updateSetting("cooldown_secs", event.target.value)}
              />
            </label>
            <label>
              {t.topCount}
              <input
                inputMode="numeric"
                min="3"
                max="20"
                pattern="[0-9]*"
                type="text"
                value={draftSettings.top_apps_limit}
                onChange={(event) => updateSetting("top_apps_limit", event.target.value)}
              />
            </label>
            <label>
              {t.language}
              <select
                value={draftSettings.language}
                onChange={(event) => updateSetting("language", event.target.value)}
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
            </label>
          </div>
          <button type="button" onClick={saveSettings}>
            {t.save}
          </button>
          {settingsStatus ? <p className="status-text">{settingsStatus}</p> : null}

          <div className="update-row">
            <div>
              <strong>{t.notifications}</strong>
              <p className="status-text">{notificationStatusText(notificationPermission)}</p>
            </div>
            <div className="update-actions">
              <label className="switch-control">
                <span className="switch-label">
                  {notificationPermission === "granted" ? t.testNotifications : t.enableNotifications}
                </span>
                <input
                  aria-label={t.notifications}
                  checked={notificationPermission === "granted"}
                  onChange={toggleNotifications}
                  type="checkbox"
                />
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" />
                </span>
              </label>
            </div>
          </div>

          <div className="update-row">
            <div>
              <strong>{t.updates}</strong>
              <p className="status-text">{updateStatus}</p>
            </div>
            <div className="update-actions">
              <button type="button" className="secondary-button compact-button" onClick={checkForUpdates}>
                {t.updates}
              </button>
              {availableUpdate ? (
                <button type="button" className="compact-button" onClick={installAvailableUpdate}>
                  {t.install}
                </button>
              ) : null}
            </div>
          </div>
          </section>
        ) : null}

        {activeTab === "feedback" ? (
          <section className="tab-panel feedback-panel">
            <h2>{t.emailTitle}</h2>
            <p>{t.emailHelp}</p>
            <a className="email-link" href={emailHref}>
              {emailAddress}
            </a>
          </section>
        ) : null}
      </div>

      {selectedApp ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            aria-labelledby="quit-dialog-title"
            aria-modal="true"
            className="dialog"
            role="dialog"
          >
            <h2 id="quit-dialog-title">{t.quitTitle}</h2>
            <p>{t.quitHelp}</p>
            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={() => setSelectedApp(null)}>
                {t.cancel}
              </button>
              <button type="button" onClick={() => terminateSelectedApp(false)}>
                {t.quitApp}
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => terminateSelectedApp(true)}
              >
                {t.forceQuit}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default App;
