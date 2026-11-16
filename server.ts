import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  buildCompileRepairContents,
  buildUserContents,
  getArchitectSystemInstruction,
  type BuildMode,
  type ChatTurn,
  type DesignPreset,
} from './server/architectPrompt.ts';
import { ArchitectStreamParser } from './server/streamParser.ts';
import { compileVirtualReactProject } from './server/bundler.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '6mb' }));

const PORT = Number(process.env.PORT || 3000);
const MODEL_NAME = 'gemini-4-hydrogen';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'Chave da API Gemini não configurada. Adicione GEMINI_API_KEY em Settings > Secrets para gerar sites.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model: MODEL_NAME,
    configured: Boolean(
      process.env.GEMINI_API_KEY &&
        process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
    ),
  });
});

interface BundleRequestBody {
  files?: Record<string, string>;
}

app.post('/api/preview/bundle', async (req, res) => {
  const body = (req.body ?? {}) as BundleRequestBody;
  const files =
    body.files && typeof body.files === 'object' ? body.files : {};

  if (Object.keys(files).length === 0) {
    res.status(400).json({ ok: false, errors: ['Nenhum arquivo fornecido.'] });
    return;
  }

  const previewResult = await compileVirtualReactProject(files, {
    withErrorBridge: true,
  });

  if (!previewResult.ok) {
    res.json({
      ok: false,
      compiledHtml: '',
      standaloneHtml: '',
      errors: previewResult.errors,
    });
    return;
  }

  const standaloneResult = await compileVirtualReactProject(files, {
    withErrorBridge: false,
  });

  res.json({
    ok: true,
    compiledHtml: previewResult.html,
    standaloneHtml: standaloneResult.html,
    errors: [],
  });
});

interface BuildRequestBody {
  prompt?: string;
  history?: ChatTurn[];
  currentFiles?: Record<string, string>;
  buildMode?: BuildMode;
  designPreset?: DesignPreset;
}

app.post('/api/build/stream', async (req, res) => {
  const body = (req.body ?? {}) as BuildRequestBody;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

  if (!prompt) {
    res
      .status(400)
      .json({ error: 'Descreva o site ou alteração que deseja construir.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event: string, data: unknown) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  try {
    const ai = getGeminiClient();
    const buildMode: BuildMode = body.buildMode === 'quick' ? 'quick' : 'full';
    const designPreset: DesignPreset = body.designPreset ?? 'auto';
    const history = Array.isArray(body.history) ? body.history : [];
    const currentFiles =
      body.currentFiles && typeof body.currentFiles === 'object'
        ? body.currentFiles
        : {};

    const mergedFiles: Record<string, string> = { ...currentFiles };

    const streamTurn = async (
      contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
      thinkingLevel: ThinkingLevel,
      isRepairPass: boolean
    ): Promise<number> => {
      const stream = await ai.models.generateContentStream({
        model: MODEL_NAME,
        contents,
        config: {
          systemInstruction: getArchitectSystemInstruction(designPreset),
          thinkingConfig: {
            thinkingLevel,
          },
        },
      });

      const parser = new ArchitectStreamParser();
      let currentPhase: 'planning' | 'coding' | 'summarizing' = 'planning';
      let filesWritten = 0;
      const fileBuffers: Record<string, string> = {};

      const handleParsedEvents = (
        events: ReturnType<ArchitectStreamParser['push']>
      ) => {
        for (const ev of events) {
          if (ev.type === 'plan_delta') {
            if (!isRepairPass) {
              sendEvent('plan_delta', { text: ev.text });
            }
          } else if (ev.type === 'file_start') {
            if (currentPhase !== 'coding') {
              currentPhase = 'coding';
              sendEvent('phase', {
                phase: 'coding',
                label: isRepairPass
                  ? 'Corrigindo erros detectados na compilação'
                  : 'Escrevendo componentes React, TypeScript e estilos',
              });
            }
            fileBuffers[ev.path] = '';
            sendEvent('file_start', { path: ev.path });
          } else if (ev.type === 'file_delta') {
            fileBuffers[ev.path] = (fileBuffers[ev.path] || '') + ev.chunk;
            sendEvent('file_delta', { path: ev.path, chunk: ev.chunk });
          } else if (ev.type === 'file_end') {
            mergedFiles[ev.path] = fileBuffers[ev.path] || '';
            filesWritten += 1;
            sendEvent('file_end', { path: ev.path });
          } else if (ev.type === 'summary_delta') {
            if (currentPhase !== 'summarizing') {
              currentPhase = 'summarizing';
              sendEvent('phase', {
                phase: 'verifying',
                label: 'Consolidando resumo da arquitetura',
              });
            }
            sendEvent('summary_delta', { text: ev.text });
          }
        }
      };

      for await (const chunk of stream) {
        if (closed) break;
        const text = chunk.text;
        if (!text) continue;
        handleParsedEvents(parser.push(text));
      }

      if (!closed) {
        handleParsedEvents(parser.flush());
      }

      return filesWritten;
    };

    sendEvent('phase', {
      phase: 'planning',
      label:
        Object.keys(currentFiles).length > 0
          ? 'Analisando projeto atual e planejando alterações'
          : 'Planejando arquitetura modular e experiência do usuário',
    });

    const initialThinking =
      buildMode === 'quick' ? ThinkingLevel.LOW : ThinkingLevel.HIGH;

    const initialCount = await streamTurn(
      buildUserContents({ prompt, history, currentFiles }),
      initialThinking,
      false
    );

    if (closed) return;

    if (initialCount === 0 && Object.keys(mergedFiles).length === 0) {
      sendEvent('error', {
        message:
          'A resposta não retornou arquivos completos. Tente descrever o site novamente com mais detalhes.',
      });
      return;
    }

    // Automatic Compile & Self-Repair Loop (up to 2 repair passes)
    let compileResult = await compileVirtualReactProject(mergedFiles, {
      withErrorBridge: true,
    });
    let attempts = 0;

    while (!compileResult.ok && attempts < 2 && !closed) {
      attempts += 1;
      sendEvent('phase', {
        phase: 'verifying',
        label: `Corrigindo compilação automaticamente (tentativa ${attempts}/2)`,
      });

      await streamTurn(
        buildCompileRepairContents({
          originalPrompt: prompt,
          currentFiles: mergedFiles,
          compileErrors: compileResult.errors,
        }),
        ThinkingLevel.LOW,
        true
      );

      if (closed) return;

      compileResult = await compileVirtualReactProject(mergedFiles, {
        withErrorBridge: true,
      });
    }

    if (closed) return;

    if (!compileResult.ok) {
      sendEvent('error', {
        message: `Não foi possível compilar automaticamente: ${compileResult.errors.join(' | ')}`,
      });
      return;
    }

    sendEvent('phase', {
      phase: 'verifying',
      label: 'Build compilado com sucesso e pronto para produção',
    });

    const standaloneResult = await compileVirtualReactProject(mergedFiles, {
      withErrorBridge: false,
    });

    sendEvent('bundle_ready', {
      compiledHtml: compileResult.html,
      standaloneHtml: standaloneResult.html,
    });

    sendEvent('done', {
      filesCount: Object.keys(mergedFiles).length,
      autoRepaired: attempts > 0,
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : 'Erro inesperado ao gerar o projeto com Gemini.';
    console.error('[/api/build/stream] Error:', err);
    sendEvent('error', { message });
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Forja Studio running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
