import localFont from 'next/font/local';

// Variable woff2 files from Google Fonts (SIL OFL, licenses alongside); served from this app, no runtime network.
export const instrumentSans = localFont({
  src: [
    { path: './instrument-sans-latin.woff2', weight: '400 700', style: 'normal' },
    { path: './instrument-sans-latin-ext.woff2', weight: '400 700', style: 'normal' },
  ],
  variable: '--font-instrument-sans',
  display: 'swap',
});

export const bricolageGrotesque = localFont({
  src: [
    { path: './bricolage-grotesque-latin.woff2', weight: '200 800', style: 'normal' },
    { path: './bricolage-grotesque-latin-ext.woff2', weight: '200 800', style: 'normal' },
  ],
  variable: '--font-bricolage-grotesque',
  display: 'swap',
});

export const jetbrainsMono = localFont({
  src: [
    { path: './jetbrains-mono-latin.woff2', weight: '100 800', style: 'normal' },
    { path: './jetbrains-mono-latin-ext.woff2', weight: '100 800', style: 'normal' },
  ],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});
