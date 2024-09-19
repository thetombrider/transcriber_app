'use client'
import { useState, FormEvent } from 'react';
import { Button, TextField, Typography, Box, CircularProgress, Paper, LinearProgress } from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';

export default function TranscriptionForm() {
  const [file, setFile] = useState<File | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [transcription, setTranscription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !apiKey) {
      console.error('File or API key missing');
      return;
    }

    setIsLoading(true);
    setProgress(0);
    setTranscription('');
    const formData = new FormData();
    formData.append('file', file);
    formData.append('apiKey', apiKey);

    try {
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
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
        const updates = chunk.split('\n').filter(Boolean).map(JSON.parse);

        for (const update of updates) {
          if (update.error) {
            throw new Error(update.error);
          }
          setProgress(update.progress);
          setTranscription(update.transcription);
        }
      }
    } catch (error) {
      console.error('Error:', error);
      setTranscription(`An error occurred during transcription: ${error.message}`);
    } finally {
      setIsLoading(false);
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
              accept="audio/*"
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
          label="OpenAI API Key"
          variant="outlined"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          sx={{ mb: 3 }}
        />
        <Button
          type="submit"
          variant="contained"
          color="primary"
          disabled={isLoading || !file || !apiKey}
          fullWidth
        >
          {isLoading ? <CircularProgress size={24} /> : 'Transcribe'}
        </Button>
      </form>
      {isLoading && (
        <Box sx={{ width: '100%', mt: 2 }}>
          <LinearProgress variant="determinate" value={progress} />
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