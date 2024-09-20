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

const CHUNK_SIZE = 1 * 1024 * 1024; // 1 MB

async function splitAudioIntoChunks(filePath: string): Promise<string[]> {
  const outputDir = path.join(os.tmpdir(), 'transcriber-temp');
  await ensureDir(outputDir);

  const { size } = await fsPromises.stat(filePath);
  const numberOfChunks = Math.ceil(size / CHUNK_SIZE);

  const chunkPromises = Array.from({ length: numberOfChunks }, (_, i) =>
    splitChunk(filePath, outputDir, i, CHUNK_SIZE, size)
  );

  return Promise.all(chunkPromises);
}

async function splitChunk(filePath: string, outputDir: string, index: number, chunkSize: number, totalSize: number): Promise<string> {
  const outputPath = path.join(outputDir, `chunk_${index}.mp3`);
  const start = index * chunkSize;
  const end = Math.min((index + 1) * chunkSize, totalSize) - 1;

  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .setStartTime(0)
      .setDuration(0)
      .inputOptions(`-ss ${start}`)
      .inputOptions(`-to ${end}`)
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

async function convertToMp3(inputPath: string): Promise<string> {
  const outputPath = path.join(path.dirname(inputPath), `converted-${Date.now()}.mp3`);
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat('mp3')
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .audioChannels(1)
      .audioFrequency(16000)
      .on('error', (err) => {
        console.error('Error in ffmpeg conversion:', err);
        reject(err);
      })
      .on('end', () => {
        console.log(`Successfully converted to MP3: ${outputPath}`);
        resolve(outputPath);
      })
      .save(outputPath);
  });
}

async function getAudioFormat(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
      } else if (typeof metadata.format.format_name === 'string') {
        resolve(metadata.format.format_name);
      } else {
        reject(new Error('Invalid format_name'));
      }
    });
  });
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const processAudio = async () => {
    let tempFilePath: string | null = null;
    let mp3FilePath: string | null = null;

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
        tempFilePath = path.join(tempDir, `input-${Date.now()}.${file.name.split('.').pop()}`);
        await fsPromises.writeFile(tempFilePath, buffer);
        console.log(`Original file saved to: ${tempFilePath}`);
      } else if (url) {
        tempFilePath = await downloadFromUrl(url);
        console.log(`File downloaded from URL to: ${tempFilePath}`);
      } else {
        throw new Error('No file or URL provided');
      }

      // Check audio format
      const audioFormat = await getAudioFormat(tempFilePath);
      console.log(`Original audio format: ${audioFormat}`);

      // Convert the audio to MP3 if it's not already
      if (!audioFormat.includes('mp3')) {
        mp3FilePath = await convertToMp3(tempFilePath);
        console.log(`Converted MP3 file: ${mp3FilePath}`);
      } else {
        mp3FilePath = tempFilePath;
        console.log(`File is already in MP3 format: ${mp3FilePath}`);
      }

      // Check if the MP3 file exists and is not empty
      const mp3Stats = await fsPromises.stat(mp3FilePath);
      if (mp3Stats.size === 0) {
        throw new Error('MP3 file is empty');
      }

      const chunks = await splitAudioIntoChunks(mp3FilePath);
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
          if (error.response && error.response.status === 400) {
            throw new Error(`The audio chunk ${i + 1} could not be decoded or its format is not supported.`);
          }
          throw error;
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
      if (tempFilePath) await fsPromises.unlink(tempFilePath).catch(console.error);
      if (mp3FilePath) await fsPromises.unlink(mp3FilePath).catch(console.error);
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