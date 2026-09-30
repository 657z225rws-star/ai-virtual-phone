"use client";

// 主动消息 API —— 云端生成专用的模型配置（跟角色聊天的 API 分开）
// 版式对齐旁边的「API 设置 / 语音 API」：斜体大标题 + 卡片列表 + 右上角新增 + 底部弹层编辑。

import { useCallback, useContext, useEffect, useState } from "react";
import { AlertCircle, Check, FileEdit, Loader2, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { Alert } from "@/components/ui/feedback";
import { ConfirmDialog } from "@/components/ui/modal";
import { Input, Select } from "@/components/ui/form";
import { SettingsContext } from "../phone-settings-app";
import { loadApiConfigs } from "@/lib/settings-storage";
import { determineBaseUrl } from "@/lib/api-helpers";
import type { ApiConfig } from "@/lib/settings-types";
import {
    loadActiveCloudApi,
    loadProactiveCloudConfig,
    makeCloudApiId,
    openAiCompatibleRoot,
    patchProactiveCloudConfig,
    resolveCloudLlm,
    testProactiveCloudApi,
    type ProactiveCloudApiEntry,
    type ProactiveCloudConfig,
} from "@/lib/proactive-cloud";

type StatusTone = "info" | "success" | "danger" | "warning";

const ADD_BUTTON_CLASS = "inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none";

export function ProactiveApiSettings({ onNotice }: { onNotice: (msg: string) => void }) {
    const { setSubpageRightAction } = useContext(SettingsContext);
    const [config, setConfig] = useState<ProactiveCloudConfig>(() => loadProactiveCloudConfig());
    const [apiConfigs, setApiConfigs] = useState<ApiConfig[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isNew, setIsNew] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<{ tone: StatusTone; text: string } | null>(null);

    useEffect(() => {
        setApiConfigs(loadApiConfigs());
        setConfig(loadProactiveCloudConfig());
    }, []);

    const persist = useCallback((entries: ProactiveCloudApiEntry[], activeId?: string) => {
        const next = patchProactiveCloudConfig({
            cloudApis: entries,
            activeCloudApiId: activeId ?? (entries.some(item => item.id === config.activeCloudApiId)
                ? config.activeCloudApiId
                : (entries[0]?.id ?? "")),
        });
        setConfig(next);
        return next;
    }, [config.activeCloudApiId]);

    const addConfig = useCallback(() => {
        // 刻意从存储读最新配置、依赖为空：这样这个回调是稳定的，
        // 挂到"右上角新增"按钮上不会因为配置变化而反复重建、把本组件的状态冲掉。
        const current = loadProactiveCloudConfig();
        const entry: ProactiveCloudApiEntry = { id: makeCloudApiId(), name: "", apiUrl: "", apiKey: "", model: "" };
        const entries = [...current.cloudApis, entry];
        const next = patchProactiveCloudConfig({
            cloudApis: entries,
            activeCloudApiId: current.activeCloudApiId || entry.id,
        });
        setConfig(next);
        setIsNew(true);
        setEditingId(entry.id);
        setStatus(null);
    }, []);

    useEffect(() => {
        setSubpageRightAction("proactiveApi",
            <button onClick={addConfig} className={ADD_BUTTON_CLASS}>
                <Plus size={15} strokeWidth={1.8} />
                <span>新增 API</span>
            </button>
        );
        return () => setSubpageRightAction("proactiveApi", null);
    }, [addConfig, setSubpageRightAction]);

    const editing: ProactiveCloudApiEntry | undefined = config.cloudApis.find(item => item.id === editingId);

    /**
     * 下拉里该显示哪条已有配置：按内容匹配（地址 + Key 一致就算同一条），
     * 而不是只认之前存下的 id —— 这样老数据、以及手动改过字段的情况都能正确回显。
     */
    const matchedConfigId = (() => {
        if (!editing) return "";
        const byContent = apiConfigs.find(item =>
            openAiCompatibleRoot(determineBaseUrl(item)) === openAiCompatibleRoot(editing.apiUrl)
            && (item.apiKey || "") === (editing.apiKey || ""));
        return byContent?.id ?? editing.sourceConfigId ?? "";
    })();

    const updateEntry = useCallback((id: string, patch: Partial<ProactiveCloudApiEntry>) => {
        persist(config.cloudApis.map(item => item.id === id ? { ...item, ...patch } : item));
    }, [config.cloudApis, persist]);

    const removeEntry = useCallback((id: string) => {
        const entries = config.cloudApis.filter(item => item.id !== id);
        persist(entries, config.activeCloudApiId === id ? (entries[0]?.id ?? "") : config.activeCloudApiId);
    }, [config.activeCloudApiId, config.cloudApis, persist]);

    const handleFillFromConfig = useCallback((id: string) => {
        const picked = apiConfigs.find(item => item.id === id);
        if (!picked || !editing) return;
        // 名字直接跟着这条配置走，不需要用户手填；sourceConfigId 存起来供界面回显"选的是哪条"
        updateEntry(editing.id, {
            apiUrl: openAiCompatibleRoot(determineBaseUrl(picked)),
            apiKey: picked.apiKey || "",
            model: picked.defaultModel || "",
            name: picked.name || picked.provider || "",
            sourceConfigId: id,
        });
        onNotice(`已填入「${picked.name || picked.provider}」`);
    }, [apiConfigs, editing, onNotice, updateEntry]);

    const closeEditor = useCallback(() => {
        if (isNew && editing) removeEntry(editing.id);
        setIsNew(false);
        setEditingId(null);
        setStatus(null);
    }, [editing, isNew, removeEntry]);

    const handleTest = useCallback(async () => {
        if (!editing) return;
        setBusy(true);
        setStatus({ tone: "info", text: "正在调用…" });
        try {
            updateEntry(editing.id, { apiUrl: openAiCompatibleRoot(editing.apiUrl) });
            const resolved = resolveCloudLlm({ ...config, activeCloudApiId: editing.id });
            if (!resolved.ok) throw new Error(resolved.reason);
            const result = await testProactiveCloudApi({ ...config, activeCloudApiId: editing.id });
            if (!result.ok) throw new Error(result.reason || "调用失败");
            setStatus({ tone: "success", text: `通了，模型回答：${result.reply}` });
        } catch (error) {
            setStatus({ tone: "danger", text: error instanceof Error ? error.message : String(error) });
        } finally {
            setBusy(false);
        }
    }, [config, editing, updateEntry]);

    const activeEntry = loadActiveCloudApi(config);
    const activeResolved = resolveCloudLlm(config);

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Proactive API</h2>
            </div>

            {config.cloudApis.length === 0 ? (
                <div className="ui-empty">
                    <div className="ui-icon-circle">
                        <Plus size={24} />
                    </div>
                    <span className="menu-label font-semibold">还没有配置</span>
                    <span className="menu-desc max-w-[240px]">
                        云端生成主动消息用的接口，跟角色聊天的 API 互不影响。
                    </span>
                    <button onClick={addConfig} className="ui-btn ui-btn-primary rounded-[20px] mt-2">
                        <Plus size={16} /> 添加配置
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-3">
                    {config.cloudApis.map(entry => {
                        const isActive = entry.id === (activeEntry?.id ?? "");
                        return (
                            <div
                                key={entry.id}
                                className="ui-config-card min-w-0 cursor-pointer"
                                style={{ aspectRatio: "3 / 2", padding: "12px", justifyContent: "space-between" }}
                                role="button"
                                tabIndex={0}
                                aria-label={`编辑 ${entry.name}`}
                                onClick={() => { setIsNew(false); setEditingId(entry.id); setStatus(null); }}
                                onKeyDown={(event) => {
                                    if (event.target !== event.currentTarget) return;
                                    if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault();
                                        setIsNew(false);
                                        setEditingId(entry.id);
                                    }
                                }}
                            >
                                <div className="min-w-0 flex flex-col gap-1">
                                    <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">
                                        {entry.name || entry.model || "未命名"}
                                    </span>
                                    <span className="menu-desc truncate">
                                        {entry.name && entry.model ? entry.model : (entry.apiUrl || "未设置接口地址")}
                                    </span>
                                </div>
                                <div className="flex gap-2 shrink-0 items-center justify-end">
                                    {isActive ? (
                                        <span className="ui-badge">使用中</span>
                                    ) : (
                                        <button
                                            type="button"
                                            className="ui-link-btn"
                                            onClick={(event) => { event.stopPropagation(); persist(config.cloudApis, entry.id); }}
                                        >
                                            使用
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={(event) => { event.stopPropagation(); setIsNew(false); setEditingId(entry.id); setStatus(null); }}
                                        className="ui-link-btn"
                                    >
                                        <FileEdit size={18} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={(event) => { event.stopPropagation(); setConfirmDeleteId(entry.id); }}
                                        className="ui-link-btn"
                                        data-variant="danger"
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {!activeResolved.ok && activeEntry ? <Alert variant="warning">{activeResolved.reason}</Alert> : null}

            {editing && (
                <div className="modal-overlay modal-overlay-bottom">
                    <div className="modal-sheet" data-ui="modal-sheet">
                        <div className="modal-header" data-ui="modal-header">
                            <button onClick={closeEditor} className="modal-header-btn modal-header-btn-muted"><X size={18} /></button>
                            <span className="modal-header-title">{isNew ? "添加配置" : "编辑配置"}</span>
                            <button onClick={closeEditor} className="modal-header-btn modal-header-btn-action"><Check size={18} /></button>
                        </div>

                        <div className="modal-body hide-scrollbar flex flex-col gap-4 pb-10" data-ui="modal-body">
                            {apiConfigs.length > 0 ? (
                                <div className="flex flex-col gap-1">
                                    <label className="menu-desc ml-1">从已有配置填入</label>
                                    <Select
                                        value={matchedConfigId}
                                        onChange={event => {
                                            if (event.target.value) handleFillFromConfig(event.target.value);
                                        }}
                                    >
                                        <option value="">选择一条配置…</option>
                                        {apiConfigs.map(item => (
                                            <option key={item.id} value={item.id}>{item.name || item.provider}</option>
                                        ))}
                                    </Select>
                                </div>
                            ) : null}

                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">接口地址</label>
                                <Input
                                    value={editing.apiUrl}
                                    onChange={event => updateEntry(editing.id, { apiUrl: event.target.value })}
                                    onBlur={() => updateEntry(editing.id, { apiUrl: openAiCompatibleRoot(editing.apiUrl) })}
                                    placeholder="https://你的中转站.com"
                                    autoComplete="off"
                                    spellCheck={false}
                                />
                            </div>

                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">API Key</label>
                                <Input
                                    value={editing.apiKey}
                                    onChange={event => updateEntry(editing.id, { apiKey: event.target.value })}
                                    placeholder="sk-..."
                                    autoComplete="off"
                                    spellCheck={false}
                                />
                            </div>

                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">模型名</label>
                                <Input
                                    value={editing.model}
                                    onChange={event => updateEntry(editing.id, { model: event.target.value })}
                                    placeholder="例如 gemini-3.8-flash"
                                    autoComplete="off"
                                    spellCheck={false}
                                />
                            </div>

                            {status ? <Alert variant={status.tone === "info" ? "info" : status.tone}>{status.text}</Alert> : null}

                            <button type="button" className="ui-btn ui-btn-primary w-full" disabled={busy} onClick={handleTest}>
                                {busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />} 测试这个 API
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除这条配置后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => { removeEntry(confirmDeleteId); setConfirmDeleteId(null); }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
        </div>
    );
}
