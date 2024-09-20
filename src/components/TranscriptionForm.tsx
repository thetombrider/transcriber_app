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
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [chunkTranscriptions, setChunkTranscriptions] = useState<string[]>([]);
  const [chunkProgress, setChunkProgress] = useState({ current: 0, total: 0 });
  const [jobId, setJobId] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

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
    setChunkTranscriptions([]);
    const formData = new FormData();
    if (file) formData.append('file', file);
    if (url) formData.append('url', url);
    formData.append('api_key', apiKey);

    const controller = new AbortController();
    setAbortController(controller);

    try {
      const response = await fetch('https://transcriber-api-goao.onrender.com/transcribe/file', {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      setJobId(result.job_id);
      setProgress(100);
      setTranscription(result.transcription);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        setTranscription('Transcription cancelled');
      } else {
        console.error('Error:', error);
        setTranscription(`An error occurred during transcription: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } finally {
      setIsLoading(false);
      setAbortController(null);
    }
  };

  const handleCancel = async () => {
    if (jobId) {
      try {
        const response = await fetch(`https://transcriber-api-goao.onrender.com/cancel_transcription/${jobId}`, {
          method: 'POST',
        });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const result = await response.json();
        console.log(result.message);
      } catch (error) {
        console.error('Error cancelling transcription:', error);
      }
    }
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
              accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/webm,audio/ogg"
              onChange={handleFileChange}
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
      {chunkTranscriptions.map((chunk, index) => (
        <Typography key={index} variant="body1" sx={{ mt: 2 }}>
          Chunk {index + 1}: {chunk}
        </Typography>
      ))}
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