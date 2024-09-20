import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import os from 'os';
import { mkdir } from 'fs/promises';
import axios from 'axios';

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

      let audioFile: File;
      if (file) {
        audioFile = file;
      } else if (url) {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const blob = new Blob([response.data], { type: 'audio/mpeg' });
        audioFile = new File([blob], 'audio.mp3', { type: 'audio/mpeg' });
      } else {
        throw new Error('No file or URL provided');
      }

      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1',
        language: 'it'
      });

      await writer.write(encoder.encode(JSON.stringify({ 
        progress: 100, 
        transcription: transcription.text.trim(),
      }) + '\n'));

      console.log('Transcription completed successfully');
      await writer.close();
    } catch (error: unknown) {
      console.error('Error in processAudio:', error);
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