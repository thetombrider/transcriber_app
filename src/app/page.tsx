import TranscriptionForm from '../components/TranscriptionForm';
import { Container, Typography } from '@mui/material';

export default function Home() {
  return (
    <Container maxWidth="md" sx={{ mt: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom align="center">
        Audio Transcription App
      </Typography>
      <TranscriptionForm />
    </Container>
  );
}
