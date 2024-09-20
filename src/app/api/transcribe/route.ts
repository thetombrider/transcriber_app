import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import os from 'os';
import { ensureDir } from 'fs-extra';
import axios from 'axios';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const CHUNK_SIZE = 20 * 1024 * 1024; // 20 MB

async function splitAudioIntoChunks(filePath: string): Promise<string[]> {
  const outputDir = path.join(os.tmpdir(), 'transcriber-temp');
  await ensureDir(outputDir);

  const duration = await getAudioDuration(filePath);
  const chunkDuration = await calculateChunkDuration(filePath, CHUNK_SIZE);
  const numberOfChunks = Math.ceil(duration / chunkDuration);

  const chunkPromises = Array.from({ length: numberOfChunks }, (_, i) =>
    splitChunk(filePath, outputDir, i, chunkDuration)
  );

  return Promise.all(chunkPromises);
}

async function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration || 0);
    });
  });
}

async function calculateChunkDuration(filePath: string, targetSize: number): Promise<number> {
  const { size } = await fsPromises.stat(filePath);
  const duration = await getAudioDuration(filePath);
  return (duration * targetSize) / size;
}

async function splitChunk(filePath: string, outputDir: string, index: number, chunkDuration: number): Promise<string> {
  const outputPath = path.join(outputDir, `chunk_${index}.mp3`);
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .setStartTime(index * chunkDuration)
      .setDuration(chunkDuration)
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
}

async function downloadFromUrl(url: string): Promise<string> {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const tempDir = path.join(os.tmpdir(), 'transcriber-temp');
  await ensureDir(tempDir);
  const tempFilePath = path.join(tempDir, `input-${Date.now()}.mp3`);
  await fsPromises.writeFile(tempFilePath, response.data);
  return tempFilePath;
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

      const chunks = await splitAudioIntoChunks(tempFilePath);

      let fullTranscription = '';
      for (let i = 0; i < chunks.length; i++) {
        if (req.signal.aborted) {
          throw new Error('Transcription cancelled');
        }

        const chunk = chunks[i];
        const chunkStream = fs.createReadStream(chunk as string);
        const transcription = await openai.audio.transcriptions.create({
          file: chunkStream,
          model: 'whisper-1',
        });
        fullTranscription += transcription.text + ' ';

        const progress = Math.round(((i + 1) / chunks.length) * 100);
        await writer.write(encoder.encode(JSON.stringify({ 
          progress, 
          transcription: fullTranscription.trim(),
          chunkTranscription: transcription.text.trim(),
          chunkProgress: {
            current: i + 1,
            total: chunks.length
          }
        }) + '\n'));

        chunkStream.destroy();
      }

      // Clean up temporary files
      await fsPromises.unlink(tempFilePath);
      for (const chunk of chunks) {
        await fsPromises.unlink(chunk);
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

  return new NextResponse(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}