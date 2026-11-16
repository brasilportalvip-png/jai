import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Code2, Eye, MessageSquare, ShieldCheck } from 'lucide-react';
import { TopBar } from './components/TopBar';
import { ChatArchitect } from './components/ChatArchitect';
import { PreviewCanvas } from './components/PreviewCanvas';
import { CodeExplorer } from './components/CodeExplorer';
import { AuditPanel } from './components/AuditPanel';
import {
  assembleStandaloneHtml,
  exportProjectAsZip,
  runProductionAudit,
  slugifyProjectName,
  triggerFileDownload,
} from './utils/projectPackager';
import type {
  BuildMode,
  BuildPhase,
  ChatMessage,
  DesignPreset,
  DeviceViewport,
  GeneratedFileMeta,
  RuntimeErrorEvent,
  StudioProject,
  WorkspaceView,
} from './types/studio';

const STORAGE_KEY = 'forja_studio_projects_v1';
const ACTIVE_PROJECT_KEY = 'forja_studio_active_project_v1';
const THEME_KEY = 'forja_studio_theme_v1';

function createEmptyProject(index = 1): StudioProject {
  const now = Date.now();
  return {
    id: `proj_${now}_${Math.random().toString(36).slice(2, 7)}`,
    name: index === 1 ? 'Meu Site em Produção' : `Novo Projeto ${index}`,
    slug: 'meu-site-producao',
    createdAt: now,
    updatedAt: now,
    files: {},
    messages: [],
  };
}

function loadInitialProjects(): StudioProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StudioProject[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
    // Ignore storage read errors
  }
  return [createEmptyProject(1)];
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

export default function App() {
  const [projects, setProjects] = useState<StudioProject[]>(loadInitialProjects);
  const [activeProjectId, setActiveProjectId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_PROJECT_KEY);
      if (saved) return saved;
    } catch {
      // Ignore
    }
    return '';
  });

  const [isDark, setIsDark] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light') return false;
      if (saved === 'dark') return true;
    } catch {
      // Ignore
    }
    return true;
  });

  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('preview');
  const [deviceViewport, setDeviceViewport] = useState<DeviceViewport>('desktop');
  const [mobilePane, setMobilePane] = useState<'chat' | 'canvas'>('chat');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [promptInput, setPromptInput] = useState('');
  const [buildMode, setBuildMode] = useState<BuildMode>('full');
  const [designPreset, setDesignPreset] = useState<DesignPreset>('auto');
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeFilePath, setActiveFilePath] = useState('src/App.tsx');
  const [runtimeError, setRuntimeError] = useState<RuntimeErrorEvent | null>(null);

  // Compiled HTML cache (produced by server-side esbuild)
  const [compiledHtml, setCompiledHtml] = useState('');
  const [standaloneHtml, setStandaloneHtml] = useState('');
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [isCompiling, setIsCompiling] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const skipNextAutoBundleRef = useRef(false);

  // Sync dark mode class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
    } catch {
      // Ignore
    }
  }, [isDark]);

  const activeProject = useMemo(() => {
    return projects.find((p) => p.id === activeProjectId) || projects[0];
  }, [projects, activeProjectId]);

  useEffect(() => {
    if (activeProject && activeProject.id !== activeProjectId) {
      setActiveProjectId(activeProject.id);
    }
  }, [activeProject, activeProjectId]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
      if (activeProject) {
        localStorage.setItem(ACTIVE_PROJECT_KEY, activeProject.id);
      }
    } catch {
      // Ignore quota errors
    }
  }, [projects, activeProject]);

  // Compile project files via server esbuild whenever switching projects or editing files manually
  const compileProjectFiles = useCallback(async (files: Record<string, string>) => {
    if (Object.keys(files).length === 0) {
      setCompiledHtml('');
      setStandaloneHtml('');
      setCompileErrors([]);
      return;
    }

    setIsCompiling(true);
    try {
      const res = await fetch('/api/preview/bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        compiledHtml?: string;
        standaloneHtml?: string;
        errors?: string[];
      };
      if (data.ok && data.compiledHtml) {
        setCompiledHtml(data.compiledHtml);
        setStandaloneHtml(data.standaloneHtml || data.compiledHtml);
        setCompileErrors([]);
      } else {
        setCompileErrors(data.errors || ['Falha na compilação do projeto.']);
      }
    } catch {
      // Fallback for plain HTML if server unreachable
      if (!files['src/App.tsx'] && files['index.html']) {
        setCompiledHtml(assembleStandaloneHtml(files, { withErrorBridge: true }));
        setStandaloneHtml(assembleStandaloneHtml(files, { withErrorBridge: false }));
      }
    } finally {
      setIsCompiling(false);
    }
  }, []);

  useEffect(() => {
    if (!activeProject || isGenerating) return;
    if (skipNextAutoBundleRef.current) {
      skipNextAutoBundleRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      compileProjectFiles(activeProject.files);
    }, 350);
    return () => clearTimeout(timer);
  }, [activeProject?.id, activeProject?.files, isGenerating, compileProjectFiles]);

  // Listen to preview iframe runtime errors
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; payload?: RuntimeErrorEvent } | null;
      if (data?.type === 'FORJA_PREVIEW_ERROR' && data.payload?.message) {
        setRuntimeError(data.payload);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const hasFiles = Boolean(
    activeProject?.files['src/App.tsx'] || activeProject?.files['index.html']
  );

  const auditChecks = useMemo(() => {
    if (!activeProject) return [];
    return runProductionAudit(
      activeProject.name,
      activeProject.files,
      standaloneHtml
    );
  }, [activeProject, standaloneHtml]);

  const auditIssuesCount = useMemo(() => {
    return auditChecks.filter((c) => c.status !== 'pass').length;
  }, [auditChecks]);

  const updateActiveProject = useCallback(
    (updater: (prev: StudioProject) => StudioProject) => {
      if (!activeProject) return;
      const targetId = activeProject.id;
      setProjects((prevList) =>
        prevList.map((proj) => (proj.id === targetId ? updater(proj) : proj))
      );
    },
    [activeProject]
  );

  const handleCreateProject = () => {
    if (isGenerating) return;
    const newProj = createEmptyProject(projects.length + 1);
    setProjects((prev) => [newProj, ...prev]);
    setActiveProjectId(newProj.id);
    setCompiledHtml('');
    setStandaloneHtml('');
    setCompileErrors([]);
    setRuntimeError(null);
    setWorkspaceView('preview');
  };

  const handleDeleteProject = (id: string) => {
    if (projects.length <= 1 || isGenerating) return;
    const nextList = projects.filter((p) => p.id !== id);
    setProjects(nextList);
    if (activeProject?.id === id) {
      setActiveProjectId(nextList[0].id);
      setRuntimeError(null);
    }
  };

  const handleRenameProject = (id: string, name: string) => {
    setProjects((prev) =>
      prev.map((p) =>
        p.id === id
          ? { ...p, name, slug: slugifyProjectName(name), updatedAt: Date.now() }
          : p
      )
    );
  };

  const handleUpdateFile = (filePath: string, content: string) => {
    setRuntimeError(null);
    updateActiveProject((proj) => ({
      ...proj,
      updatedAt: Date.now(),
      files: {
        ...proj.files,
        [filePath]: content,
      },
    }));
  };

  const handleStopStreaming = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsGenerating(false);
  };

  const handleSubmitPrompt = async (overridePrompt?: string) => {
    const text = (overridePrompt ?? promptInput).trim();
    if (!text || isGenerating || !activeProject) return;

    if (!overridePrompt) {
      setPromptInput('');
    }
    setRuntimeError(null);
    setCompileErrors([]);
    setIsGenerating(true);

    const userMsgId = `msg_u_${Date.now()}`;
    const assistantMsgId = `msg_a_${Date.now() + 1}`;

    const historyPayload = activeProject.messages
      .filter((m) => !m.error)
      .map((m) => ({
        role: m.role,
        content:
          m.role === 'user'
            ? m.content
            : m.summary || m.plan || 'Arquivos gerados com sucesso.',
      }));

    const filesSnapshot = { ...activeProject.files };

    const shouldAutoName =
      activeProject.messages.length === 0 &&
      (activeProject.name === 'Meu Site em Produção' ||
        activeProject.name.startsWith('Novo Projeto'));

    const derivedTitle = text
      .replace(/^(crie|faça|construa|gere|desenvolva)\s+(um|uma)\s+/i, '')
      .slice(0, 38)
      .trim();

    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: text,
      createdAt: Date.now(),
    };

    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      plan: '',
      summary: '',
      phase: 'planning',
      phaseLabel: 'Conectando ao arquiteto...',
      files: [],
      createdAt: Date.now(),
    };

    updateActiveProject((proj) => ({
      ...proj,
      name: shouldAutoName && derivedTitle.length >= 4 ? derivedTitle : proj.name,
      updatedAt: Date.now(),
      messages: [...proj.messages, userMsg, assistantMsg],
    }));

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const liveFiles: Record<string, string> = { ...filesSnapshot };
    const streamedFileMeta = new Map<string, GeneratedFileMeta>();

    const updateAssistantMessage = (
      patcher: (msg: ChatMessage) => ChatMessage,
      syncFiles = false
    ) => {
      updateActiveProject((proj) => ({
        ...proj,
        updatedAt: Date.now(),
        files: syncFiles ? { ...liveFiles } : proj.files,
        messages: proj.messages.map((m) =>
          m.id === assistantMsgId ? patcher(m) : m
        ),
      }));
    };

    try {
      const response = await fetch('/api/build/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          history: historyPayload,
          currentFiles: filesSnapshot,
          buildMode,
          designPreset,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        let errorMsg = `Erro HTTP ${response.status} ao conectar com o servidor.`;
        try {
          const errJson = (await response.json()) as { error?: string };
          if (errJson.error) errorMsg = errJson.error;
        } catch {
          // Ignore JSON parse failure
        }
        throw new Error(errorMsg);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let sseBuffer = '';

      const processSseBlock = (block: string) => {
        const lines = block.split('\n');
        let eventName = 'message';
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
          }
        }
        if (dataLines.length === 0) return;

        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
        } catch {
          return;
        }

        if (eventName === 'phase') {
          const phase = (payload.phase as BuildPhase) || 'coding';
          const label = String(payload.label || '');
          updateAssistantMessage((m) => ({
            ...m,
            phase,
            phaseLabel: label,
          }));
        } else if (eventName === 'plan_delta') {
          const delta = String(payload.text || '');
          updateAssistantMessage((m) => ({
            ...m,
            plan: (m.plan || '') + delta,
          }));
        } else if (eventName === 'file_start') {
          const filePath = String(payload.path || '');
          liveFiles[filePath] = '';
          streamedFileMeta.set(filePath, {
            path: filePath,
            status: 'writing',
            lines: 0,
            bytes: 0,
          });
          setActiveFilePath(filePath);
          updateAssistantMessage((m) => ({
            ...m,
            files: Array.from(streamedFileMeta.values()),
          }));
        } else if (eventName === 'file_delta') {
          const filePath = String(payload.path || '');
          const chunk = String(payload.chunk || '');
          liveFiles[filePath] = (liveFiles[filePath] || '') + chunk;
          const fullText = liveFiles[filePath];
          streamedFileMeta.set(filePath, {
            path: filePath,
            status: 'writing',
            lines: countLines(fullText),
            bytes: fullText.length,
          });
          updateAssistantMessage((m) => ({
            ...m,
            files: Array.from(streamedFileMeta.values()),
          }));
        } else if (eventName === 'file_end') {
          const filePath = String(payload.path || '');
          const fullText = liveFiles[filePath] || '';
          streamedFileMeta.set(filePath, {
            path: filePath,
            status: 'complete',
            lines: countLines(fullText),
            bytes: fullText.length,
          });
          updateAssistantMessage(
            (m) => ({
              ...m,
              files: Array.from(streamedFileMeta.values()),
            }),
            true
          );
        } else if (eventName === 'summary_delta') {
          const delta = String(payload.text || '');
          updateAssistantMessage((m) => ({
            ...m,
            summary: (m.summary || '') + delta,
          }));
        } else if (eventName === 'bundle_ready') {
          const readyCompiled = String(payload.compiledHtml || '');
          const readyStandalone = String(payload.standaloneHtml || readyCompiled);
          skipNextAutoBundleRef.current = true;
          setCompiledHtml(readyCompiled);
          setStandaloneHtml(readyStandalone);
          setCompileErrors([]);
          setReloadKey((k) => k + 1);
        } else if (eventName === 'done') {
          updateAssistantMessage(
            (m) => ({
              ...m,
              phase: 'done',
              phaseLabel: 'Compilado e pronto para produção',
            }),
            true
          );
          setMobilePane('canvas');
        } else if (eventName === 'error') {
          const errMessage = String(payload.message || 'Erro durante a geração.');
          updateAssistantMessage((m) => ({
            ...m,
            phase: 'error',
            error: errMessage,
          }));
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const parts = sseBuffer.split('\n\n');
        sseBuffer = parts.pop() || '';
        for (const part of parts) {
          if (part.trim()) processSseBlock(part);
        }
      }
      if (sseBuffer.trim()) {
        processSseBlock(sseBuffer);
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') {
        updateAssistantMessage(
          (m) => ({
            ...m,
            phase: 'done',
            summary: (m.summary || '') + '\n\nGeração interrompida pelo usuário.',
          }),
          true
        );
      } else {
        const message =
          err instanceof Error
            ? err.message
            : 'Falha de comunicação com o servidor.';
        updateAssistantMessage((m) => ({
          ...m,
          phase: 'error',
          error: message,
        }));
      }
    } finally {
      abortControllerRef.current = null;
      setIsGenerating(false);
    }
  };

  const handleInspectFile = (filePath: string) => {
    setActiveFilePath(filePath);
    setWorkspaceView('code');
    setMobilePane('canvas');
  };

  const handleAutoFixRuntimeError = () => {
    if (!runtimeError || isGenerating) return;
    const fixPrompt = `Corrija o seguinte erro ocorrido na execução do aplicativo: "${runtimeError.message}" (linha ${runtimeError.line || 0}). Retorne os arquivos atualizados garantindo execução 100% livre de erros.`;
    setRuntimeError(null);
    handleSubmitPrompt(fixPrompt);
  };

  const handleFixAuditIssues = (prompts: string[]) => {
    if (prompts.length === 0 || isGenerating) return;
    const combined = `Aplique as seguintes melhorias de produção no projeto atual:\n- ${prompts.join('\n- ')}`;
    handleSubmitPrompt(combined);
  };

  const handleExportZip = async () => {
    if (!activeProject || !hasFiles) return;
    const blob = await exportProjectAsZip(
      activeProject.name,
      activeProject.files,
      standaloneHtml
    );
    triggerFileDownload(blob, `${slugifyProjectName(activeProject.name)}.zip`);
  };

  const handleExportSingleHtml = () => {
    if (!activeProject || !hasFiles) return;
    const html =
      standaloneHtml ||
      assembleStandaloneHtml(activeProject.files, { withErrorBridge: false });
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    triggerFileDownload(blob, `${slugifyProjectName(activeProject.name)}.html`);
  };

  const handleCopyHtml = async (): Promise<boolean> => {
    if (!activeProject || !hasFiles) return false;
    const html =
      standaloneHtml ||
      assembleStandaloneHtml(activeProject.files, { withErrorBridge: false });
    try {
      await navigator.clipboard.writeText(html);
      return true;
    } catch {
      return false;
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-slate-50 dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100">
      <TopBar
        projects={projects}
        activeProject={activeProject}
        onSelectProject={(id) => {
          if (!isGenerating) {
            setActiveProjectId(id);
            setRuntimeError(null);
            setCompileErrors([]);
          }
        }}
        onCreateProject={handleCreateProject}
        onDeleteProject={handleDeleteProject}
        onRenameProject={handleRenameProject}
        workspaceView={workspaceView}
        onChangeView={(view) => {
          setWorkspaceView(view);
          setMobilePane('canvas');
        }}
        deviceViewport={deviceViewport}
        onChangeDevice={setDeviceViewport}
        onReloadPreview={() => {
          setRuntimeError(null);
          setReloadKey((k) => k + 1);
        }}
        onToggleFullscreen={() => setIsFullscreen((v) => !v)}
        isDark={isDark}
        onToggleTheme={() => setIsDark((v) => !v)}
        hasFiles={hasFiles}
        auditIssuesCount={auditIssuesCount}
        onExportZip={handleExportZip}
        onExportSingleHtml={handleExportSingleHtml}
        onCopyHtml={handleCopyHtml}
      />

      {/* Mobile Pane Switcher (< md) */}
      <div className="md:hidden flex border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131D] shrink-0">
        <button
          type="button"
          onClick={() => setMobilePane('chat')}
          className={`flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 border-b-2 transition-colors ${
            mobilePane === 'chat'
              ? 'border-blue-600 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-slate-500 dark:text-slate-400'
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          <span>Arquiteto</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setMobilePane('canvas');
            setWorkspaceView('preview');
          }}
          className={`flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 border-b-2 transition-colors ${
            mobilePane === 'canvas' && workspaceView === 'preview'
              ? 'border-blue-600 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-slate-500 dark:text-slate-400'
          }`}
        >
          <Eye className="w-3.5 h-3.5" />
          <span>Site</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setMobilePane('canvas');
            setWorkspaceView('code');
          }}
          className={`flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 border-b-2 transition-colors ${
            mobilePane === 'canvas' && workspaceView === 'code'
              ? 'border-blue-600 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-slate-500 dark:text-slate-400'
          }`}
        >
          <Code2 className="w-3.5 h-3.5" />
          <span>Código</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setMobilePane('canvas');
            setWorkspaceView('audit');
          }}
          className={`flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 border-b-2 transition-colors ${
            mobilePane === 'canvas' && workspaceView === 'audit'
              ? 'border-blue-600 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-slate-500 dark:text-slate-400'
          }`}
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>Auditoria</span>
        </button>
      </div>

      {/* Main Split Workspace */}
      <main className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Pane: AI Architect Chat */}
        <div
          className={`${
            mobilePane === 'chat' ? 'flex' : 'hidden'
          } md:flex w-full md:w-[390px] lg:w-[420px] shrink-0 flex-col h-full min-h-0`}
        >
          <ChatArchitect
            messages={activeProject?.messages ?? []}
            promptInput={promptInput}
            onChangePrompt={setPromptInput}
            onSubmitPrompt={handleSubmitPrompt}
            onStopStreaming={handleStopStreaming}
            isGenerating={isGenerating}
            buildMode={buildMode}
            onChangeBuildMode={setBuildMode}
            designPreset={designPreset}
            onChangeDesignPreset={setDesignPreset}
            onInspectFile={handleInspectFile}
            runtimeError={runtimeError}
            onAutoFixRuntimeError={handleAutoFixRuntimeError}
            onDismissRuntimeError={() => setRuntimeError(null)}
          />
        </div>

        {/* Right Pane: Studio Canvas (Preview / Code / Audit) */}
        <div
          className={`${
            mobilePane === 'canvas' ? 'flex' : 'hidden'
          } md:flex flex-1 flex-col min-w-0 h-full min-h-0`}
        >
          {workspaceView === 'preview' && (
            <PreviewCanvas
              files={activeProject?.files ?? {}}
              compiledHtml={compiledHtml}
              compileErrors={compileErrors}
              isCompiling={isCompiling}
              deviceViewport={deviceViewport}
              reloadKey={reloadKey}
              isGenerating={isGenerating}
              isFullscreen={isFullscreen}
              onExitFullscreen={() => setIsFullscreen(false)}
            />
          )}

          {workspaceView === 'code' && (
            <CodeExplorer
              projectName={activeProject?.name ?? 'Projeto'}
              files={activeProject?.files ?? {}}
              standaloneHtml={standaloneHtml}
              activeFilePath={activeFilePath}
              onSelectFile={setActiveFilePath}
              onUpdateFile={handleUpdateFile}
            />
          )}

          {workspaceView === 'audit' && (
            <AuditPanel
              checks={auditChecks}
              hasFiles={hasFiles}
              isGenerating={isGenerating}
              onFixAuditIssues={handleFixAuditIssues}
              onExportZip={handleExportZip}
            />
          )}
        </div>
      </main>
    </div>
  );
}
