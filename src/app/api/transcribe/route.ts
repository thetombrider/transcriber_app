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

//const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB

async function splitAudioIntoChunks(filePath: string): Promise<string[]> {
  const outputDir = path.join(os.tmpdir(), 'transcriber-temp');
  await ensureDir(outputDir);

  const { duration } = await getAudioInfo(filePath);
  const chunkDuration = 10 * 60; // 10 minutes per chunk
  const numberOfChunks = Math.ceil(duration / chunkDuration);

  const chunkPromises = Array.from({ length: numberOfChunks }, (_, i) =>
    splitChunk(filePath, outputDir, i, chunkDuration, duration)
  );

  return Promise.all(chunkPromises);
}

async function splitChunk(filePath: string, outputDir: string, index: number, chunkDuration: number, totalDuration: number): Promise<string> {
  const outputPath = path.join(outputDir, `chunk_${index}${path.extname(filePath)}`);
  const start = index * chunkDuration;
  const duration = Math.min(chunkDuration, totalDuration - start);

  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .setStartTime(start)
      .setDuration(duration)
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

async function getAudioInfo(filePath: string): Promise<{ format: string; duration: number; bitrate: number }> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve({
          format: metadata.format.format_name?.split(',')[0] || 'unknown',
          duration: metadata.format.duration || 0,
          bitrate: metadata.format.bit_rate ? parseInt(String(metadata.format.bit_rate)) : 0,
        });
      }
    });
  });
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const processAudio = async () => {
    let audioFilePath: string | null = null;

    try {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      const url = formData.get('url') as string | null;
      const apiKey = formData.get('apiKey') as string;

      if ((!file && !url) || !apiKey) {
        throw new Error('File/URL and API key are required');
      }

      const openai = new OpenAI({ apiKey });

      if (file) {
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const tempDir = path.join(os.tmpdir(), 'transcriber-temp');
        await ensureDir(tempDir);
        audioFilePath = path.join(tempDir, `input-${Date.now()}.${file.name.split('.').pop()}`);
        await fsPromises.writeFile(audioFilePath, buffer);
        console.log(`Original file saved to: ${audioFilePath}`);
      } else if (url) {
        audioFilePath = await downloadFromUrl(url);
        console.log(`File downloaded from URL to: ${audioFilePath}`);
      } else {
        throw new Error('No file or URL provided');
      }

      // Check audio format and properties
      const audioInfo = await getAudioInfo(audioFilePath);
      console.log('Audio file info:', audioInfo);

      if (audioInfo.duration < 0.1) {
        throw new Error('Audio file is too short or empty');
      }

      const chunks = await splitAudioIntoChunks(audioFilePath);
      console.log(`Split into ${chunks.length} chunks`);

      let fullTranscription = '';
      for (let i = 0; i < chunks.length; i++) {
        if (req.signal.aborted) {
          throw new Error('Transcription cancelled');
        }

        const chunk = chunks[i];
        const chunkStream = fs.createReadStream(chunk as string);
        try {
          console.log(`Processing chunk ${i + 1}/${chunks.length}`);
          const transcription = await openai.audio.transcriptions.create({
            file: chunkStream,
            model: 'whisper-1',
            language: 'it'  // Specify Italian language
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
        } catch (error: any) {
          console.error(`Error processing chunk ${i + 1}:`, error);
          if (error.response) {
            console.error('API Response:', error.response.data);
          }
          throw new Error(`Error processing chunk ${i + 1}: ${error.message}`);
        }
      }

      console.log('Transcription completed successfully');
      await writer.close();
    } catch (error: unknown) {
      console.error('Error in processAudio:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      await writer.write(encoder.encode(JSON.stringify({ error: errorMessage })));
      await writer.close();
    } finally {
      // Clean up temporary files
      if (audioFilePath) await fsPromises.unlink(audioFilePath).catch(console.error);
      // Clean up chunk files
      const tempDir = path.join(os.tmpdir(), 'transcriber-temp');
      const files = await fsPromises.readdir(tempDir);
      for (const file of files) {
        if (file.startsWith('chunk_')) {
          await fsPromises.unlink(path.join(tempDir, file)).catch(console.error);
        }
      }
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