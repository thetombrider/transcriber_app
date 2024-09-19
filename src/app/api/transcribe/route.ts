import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import os from 'os';
import ytdl from 'ytdl-core';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

async function ensureDir(dir: string) {
  try {
    await fsPromises.access(dir);
  } catch {
    await fsPromises.mkdir(dir, { recursive: true });
  }
}

async function splitAudio(filePath: string): Promise<string[]> {
  const outputDir = path.join(os.tmpdir(), 'transcriber-temp');
  await ensureDir(outputDir);

  const outputPrefix = path.join(outputDir, 'chunk');
  
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .outputOptions('-f segment')
      .outputOptions('-segment_time 300')
      .outputOptions('-c copy')
      .output(`${outputPrefix}%03d.mp3`)
      .on('end', () => {
        fsPromises.readdir(outputDir)
          .then(files => {
            const chunks = files
              .filter(file => file.startsWith('chunk') && file.endsWith('.mp3'))
              .map(file => path.join(outputDir, file));
            resolve(chunks);
          })
          .catch(reject);
      })
      .on('error', reject)
      .run();
  });
}

async function downloadFromUrl(url: string): Promise<string> {
  const tempDir = path.join(os.tmpdir(), 'transcriber-temp');
  await ensureDir(tempDir);
  const tempFilePath = path.join(tempDir, `input-${Date.now()}.mp3`);

  if (ytdl.validateURL(url)) {
    return new Promise((resolve, reject) => {
      ytdl(url, { filter: 'audioonly' })
        .pipe(fs.createWriteStream(tempFilePath))
        .on('finish', () => resolve(tempFilePath))
        .on('error', reject);
    });
  } else {
    // For other URLs, you might need to implement a different download method
    throw new Error('Unsupported URL type');
  }
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const processAudio = async () => {
    try {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      const url = formData.get('url') as string | null;
      const apiKey = formData.get('apiKey') as string;

      if ((!file && !url) || !apiKey) {
        throw new Error('File/URL and API key are required');
      }

      const openai = new OpenAI({ apiKey });

      let tempFilePath: string;
      if (file) {
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const tempDir = path.join(os.tmpdir(), 'transcriber-temp');
        await ensureDir(tempDir);
        tempFilePath = path.join(tempDir, `input-${Date.now()}.${file.name.split('.').pop()}`);
        await fsPromises.writeFile(tempFilePath, buffer);
      } else if (url) {
        tempFilePath = await downloadFromUrl(url);
      } else {
        throw new Error('No file or URL provided');
      }

      let chunks: string[];
      const fileStats = await fsPromises.stat(tempFilePath);
      if (fileStats.size > MAX_FILE_SIZE) {
        chunks = await splitAudio(tempFilePath);
      } else {
        chunks = [tempFilePath];
      }

      let fullTranscription = '';
      for (let i = 0; i < chunks.length; i++) {
        if (req.signal.aborted) {
          throw new Error('Transcription cancelled');
        }

        const chunk = chunks[i];
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(chunk),
          model: 'whisper-1',
        });
        fullTranscription += transcription.text + ' ';

        const progress = Math.round(((i + 1) / chunks.length) * 100);
        await writer.write(encoder.encode(JSON.stringify({ 
          progress, 
          transcription: fullTranscription.trim(),
          chunkProgress: {
            current: i + 1,
            total: chunks.length
          }
        }) + '\n'));
      }

      // Clean up temporary files
      await fsPromises.unlink(tempFilePath);
      for (const chunk of chunks) {
        if (chunk !== tempFilePath) {
          await fsPromises.unlink(chunk);
        }
      }

      await writer.close();
    } catch (error: unknown) {
      console.error('Error:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      await writer.write(encoder.encode(JSON.stringify({ error: errorMessage })));
      await writer.close();
    }
  };

  processAudio();

  return new Response(stream.readable, {
    headers: { 'Content-Type': 'application/json' },
  });
}