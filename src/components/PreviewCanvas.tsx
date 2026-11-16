import React, { useMemo } from 'react';
import { AlertTriangle, Layers, Loader2, Minimize2 } from 'lucide-react';
import type { DeviceViewport } from '../types/studio';
import { assembleStandaloneHtml } from '../utils/projectPackager';

interface PreviewCanvasProps {
  files: Record<string, string>;
  compiledHtml: string;
  compileErrors: string[];
  isCompiling: boolean;
  deviceViewport: DeviceViewport;
  reloadKey: number;
  isGenerating: boolean;
  isFullscreen: boolean;
  onExitFullscreen: () => void;
}

const VIEWPORT_WIDTHS: Record<DeviceViewport, string> = {
  desktop: 'w-full',
  tablet: 'w-[768px] max-w-full',
  mobile: 'w-[390px] max-w-full',
};

export const PreviewCanvas: React.FC<PreviewCanvasProps> = ({
  files,
  compiledHtml,
  compileErrors,
  isCompiling,
  deviceViewport,
  reloadKey,
  isGenerating,
  isFullscreen,
  onExitFullscreen,
}) => {
  const srcDoc = useMemo(() => {
    if (compiledHtml) return compiledHtml;
    // Fallback only if plain HTML (no src/App.tsx)
    if (!files['src/App.tsx'] && files['index.html']) {
      return assembleStandaloneHtml(files, { withErrorBridge: true });
    }
    return '';
  }, [compiledHtml, files]);

  if (compileErrors.length > 0 && !isGenerating) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center p-8 bg-slate-50 dark:bg-[#0B0F17]">
        <div className="max-w-lg w-full rounded-xl border border-red-200 dark:border-red-900/60 bg-white dark:bg-[#111723] p-5 space-y-3">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400 font-semibold text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Erro de compilação no código editado</span>
          </div>
          <pre className="text-xs font-mono text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/30 p-3 rounded-lg overflow-auto whitespace-pre-wrap">
            {compileErrors.join('\n')}
          </pre>
        </div>
      </div>
    );
  }

  if (!srcDoc) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center p-8 text-center bg-slate-50 dark:bg-[#0B0F17]">
        <div className="max-w-md space-y-4">
          <div className="w-12 h-12 rounded-xl bg-slate-200/70 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 flex items-center justify-center mx-auto">
            {isGenerating || isCompiling ? (
              <Loader2 className="w-5 h-5 animate-spin text-blue-600 dark:text-blue-400" />
            ) : (
              <Layers className="w-5 h-5" />
            )}
          </div>
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
            {isGenerating
              ? 'Construindo e compilando sua aplicação...'
              : isCompiling
                ? 'Compilando projeto...'
                : 'Área de pré-visualização ao vivo'}
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            {isGenerating
              ? 'Os componentes React estão sendo gerados, validados e compilados automaticamente para entrega sem erros.'
              : 'Escolha um modelo inicial ao lado ou descreva sua ideia para ver o site completo funcionando ao vivo.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 bg-slate-950 flex flex-col'
          : 'relative h-full w-full bg-slate-100 dark:bg-[#090D14] flex flex-col items-center justify-center overflow-hidden p-2 sm:p-4'
      }
    >
      {isFullscreen && (
        <div className="h-11 shrink-0 px-4 bg-[#0E131D] border-b border-slate-800 flex items-center justify-between">
          <span className="text-xs font-medium text-slate-300">
            Visualização em Tela Cheia
          </span>
          <button
            type="button"
            onClick={onExitFullscreen}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-medium transition-colors"
          >
            <Minimize2 className="w-3.5 h-3.5" />
            <span>Sair da Tela Cheia</span>
          </button>
        </div>
      )}

      <div
        className={`relative h-full transition-all duration-200 bg-white overflow-hidden ${
          isFullscreen
            ? 'w-full'
            : `${VIEWPORT_WIDTHS[deviceViewport]} rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm`
        }`}
      >
        {(isGenerating || isCompiling) && (
          <div className="absolute top-3 right-3 z-20 flex items-center gap-2 px-3 py-1.5 rounded-md bg-slate-900/90 text-white text-xs font-medium shadow-md">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>
              {isCompiling ? 'Compilando build...' : 'Gerando atualização...'}
            </span>
          </div>
        )}

        <iframe
          key={reloadKey}
          title="Pré-visualização do site gerado"
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-forms allow-modals allow-same-origin"
          className="w-full h-full border-0 bg-white"
        />
      </div>
    </div>
  );
};
