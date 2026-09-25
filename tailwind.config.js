/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Premium light fintech palette. `blue` is intentionally left on its
        // defaults so the dark DocsPage can keep its blue developer accents.
        cream: { 50: '#FAF8F3', 100: '#F5F1E8', 200: '#EDE7D8', 300: '#E2DAC7', 400: '#CDBFA6', 500: '#B8AF95' },
        forest: { 50: '#ECFDF5', 100: '#D9EAE1', 200: '#B4D5C5', 300: '#88BBA3', 400: '#5C9E84', 500: '#3B8368', 600: '#2D6A52', 700: '#265845', 800: '#22493B', 900: '#1E3D32', 950: '#152C24' },
        lilac: { 50: '#F5F3FA', 100: '#E9E5F5', 200: '#D3CCEC', 300: '#B6A9DB', 400: '#9785C6', 500: '#7E68B2', 600: '#68549B', 700: '#54437F', 800: '#473A6C', 900: '#3D325B' },
        gold: { 50: '#FBF8EF', 100: '#F6EFDA', 200: '#EDDDAE', 300: '#E2C97F', 400: '#D4AF54', 500: '#BE9840', 600: '#9F7C34', 700: '#7F612B', 800: '#684F26', 900: '#564223' },
        ink: { DEFAULT: '#1B2420', 50: '#F7F8F6', 100: '#EBECEA' },
        sand: { 100: '#F0EEE5', 200: '#E3DED1', 300: '#D4CDBE', 400: '#BEB6A3', 500: '#A39C86' },
      },
      boxShadow: {
        soft: '0 1px 2px 0 rgba(27,36,32,.05), 0 4px 12px -4px rgba(27,36,32,.06)',
        lift: '0 2px 6px -2px rgba(27,36,32,.06), 0 16px 32px -6px rgba(27,36,32,.12)',
        glow: '0 8px 24px -8px rgba(38,88,69,.35)',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        body: ['"DM Sans"', 'system-ui', 'sans-serif'],
      },
      container: { center: true, padding: { DEFAULT: '1.5rem' } },
    },
  },
  plugins: [],
}

