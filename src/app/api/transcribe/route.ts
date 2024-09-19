import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import os from 'os';

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

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const processChunks = async () => {
    try {
      const formData = await req.formData();
      const file = formData.get('file') as File;
      const apiKey = formData.get('apiKey') as string;

      if (!file || !apiKey) {
        throw new Error('File and API key are required');
      }

      const supportedFormats = ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm'];
      const fileExtension = file.name.split('.').pop()?.toLowerCase();
      if (!fileExtension || !supportedFormats.includes(fileExtension)) {
        throw new Error('Unsupported file format');
      }

      const openai = new OpenAI({ apiKey });

      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const tempDir = path.join(os.tmpdir(), 'transcriber-temp');
      await ensureDir(tempDir);
      const tempFilePath = path.join(tempDir, `input-${Date.now()}.${fileExtension}`);
      await fsPromises.writeFile(tempFilePath, buffer);

      let chunks: string[];
      if (buffer.length > MAX_FILE_SIZE) {
        chunks = await splitAudio(tempFilePath);
      } else {
        chunks = [tempFilePath];
      }

      let fullTranscription = '';
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(chunk),
          model: 'whisper-1',
        });
        fullTranscription += transcription.text + ' ';

        // Send progress update
        const progress = Math.round(((i + 1) / chunks.length) * 100);
        await writer.write(encoder.encode(JSON.stringify({ progress, transcription: fullTranscription.trim() })));
      }

      // Clean up temporary files
      await fsPromises.unlink(tempFilePath);
      for (const chunk of chunks) {
        if (chunk !== tempFilePath) {
          await fsPromises.unlink(chunk);
        }
      }

      await writer.close();
    } catch (error) {
      console.error('Error:', error);
      await writer.write(encoder.encode(JSON.stringify({ error: error.message })));
      await writer.close();
    }
  };

  processChunks();

  return new Response(stream.readable, {
    headers: { 'Content-Type': 'application/json' },
  });
}