'use client'
import { useState, FormEvent } from 'react';
import { Button, TextField, Typography, Box, CircularProgress, Paper, LinearProgress } from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';

export default function TranscriptionForm() {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [transcription, setTranscription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [chunkProgress, setChunkProgress] = useState({ current: 0, total: 0 });
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if ((!file && !url) || !apiKey) {
      console.error('File/URL or API key missing');
      return;
    }

    setIsLoading(true);
    setProgress(0);
    setChunkProgress({ current: 0, total: 0 });
    setTranscription('');
    const formData = new FormData();
    if (file) formData.append('file', file);
    if (url) formData.append('url', url);
    formData.append('apiKey', apiKey);

    const controller = new AbortController();
    setAbortController(controller);

    try {
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader!.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const updates = chunk.split('\n').filter(Boolean).map(item => JSON.parse(item));

        for (const update of updates) {
          if (update.error) {
            throw new Error(update.error);
          }
          setProgress(update.progress);
          setTranscription(update.transcription);
          if (update.chunkProgress) {
            setChunkProgress(update.chunkProgress);
          }
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          setTranscription('Transcription cancelled');
        } else {
          console.error('Error:', error);
          setTranscription(`An error occurred during transcription: ${error.message}`);
        }
      } else {
        console.error('Unknown error:', error);
        setTranscription('An unknown error occurred during transcription');
      }
    } finally {
      setIsLoading(false);
      setAbortController(null);
    }
  };

  const handleCancel = () => {
    if (abortController) {
      abortController.abort();
    }
  };

  return (
    <Paper elevation={3} sx={{ p: 4, maxWidth: 600, mx: 'auto' }}>
      <form onSubmit={handleSubmit}>
        <Box sx={{ mb: 3 }}>
          <Button
            variant="contained"
            component="label"
            startIcon={<CloudUploadIcon />}
            fullWidth
          >
            Upload Audio File
            <input
              type="file"
              hidden
              accept="audio/*,video/*"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </Button>
          {file && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              Selected file: {file.name}
            </Typography>
          )}
        </Box>
        <TextField
          fullWidth
          label="Or enter URL (YouTube, etc.)"
          variant="outlined"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          sx={{ mb: 3 }}
        />
        <TextField
          fullWidth
          label="OpenAI API Key"
          variant="outlined"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          sx={{ mb: 3 }}
        />
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button
            type="submit"
            variant="contained"
            color="primary"
            disabled={isLoading || (!file && !url) || !apiKey}
            fullWidth
          >
            {isLoading ? <CircularProgress size={24} /> : 'Transcribe'}
          </Button>
          {isLoading && (
            <Button
              variant="contained"
              color="secondary"
              onClick={handleCancel}
            >
              Cancel
            </Button>
          )}
        </Box>
      </form>
      {isLoading && (
        <Box sx={{ width: '100%', mt: 2 }}>
          <LinearProgress variant="determinate" value={progress} />
          <Typography variant="body2" align="center" sx={{ mt: 1 }}>
            Processing chunk {chunkProgress.current} of {chunkProgress.total}
          </Typography>
        </Box>
      )}
      {transcription && (
        <Box sx={{ mt: 4 }}>
          <Typography variant="h6" gutterBottom>
            Transcription:
          </Typography>
          <Typography variant="body1">{transcription}</Typography>
        </Box>
      )}
    </Paper>
  );
}