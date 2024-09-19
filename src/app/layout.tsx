'use client'
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import "./globals.css";

const theme = createTheme({
  palette: {
    mode: 'light',
  },
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <body>{children}</body>
      </ThemeProvider>
    </html>
  );
}
