import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const response = await axios.post('https://transcriber-api-goao.onrender.com/transcribe/file', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });

    return NextResponse.json(response.data);
  } catch (error) {
    console.error('Error in transcribe route:', error);
    return NextResponse.json({ error: 'An error occurred during transcription' }, { status: 500 });
  }
}