/** @type {import('tailwindcss').Config} */

// Tailwind is configured *against our tokens*, not extended alongside the
// defaults. The default palette, type scale, spacing scale and radii are
// replaced outright — so `bg-slate-800` or `text-sm` simply do not exist and
// the brief's constraints are enforced by the build rather than by review.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      bg: 'var(--bg)',
      surface: 'var(--surface)',
      'surface-2': 'var(--surface-2)',
      ink: 'var(--ink)',
      muted: 'var(--muted)',
      faint: 'var(--faint)',
      line: 'var(--line)',
      accent: 'var(--accent)',
      'accent-soft': 'var(--accent-soft)',
      busy: 'var(--busy)',
      free: 'var(--free)',
    },

    // 12 · 13 · 15 · 17 · 20 · 26 · 34. Body is 15, chat messages are 17.
    // Nothing between these sizes.
    fontSize: {
      12: ['12px', { lineHeight: '16px' }],
      13: ['13px', { lineHeight: '18px' }],
      15: ['15px', { lineHeight: '22px' }],
      17: ['17px', { lineHeight: '26px' }],
      20: ['20px', { lineHeight: '28px' }],
      26: ['26px', { lineHeight: '32px' }],
      34: ['34px', { lineHeight: '40px' }],
    },

    // 4px base. Nothing else.
    spacing: {
      0: '0px',
      px: '1px',
      4: '4px',
      8: '8px',
      12: '12px',
      16: '16px',
      24: '24px',
      32: '32px',
      48: '48px',
      64: '64px',
    },

    borderRadius: {
      none: '0px',
      control: '6px',
      card: '10px',
      pill: '999px',
    },

    borderWidth: {
      DEFAULT: '1px',
      0: '0px',
      1: '1px',
      2: '2px',
    },

    fontFamily: {
      sans: ['Instrument Sans', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
    },

    // 150ms for state changes, 250ms for things entering.
    transitionDuration: {
      DEFAULT: '150ms',
      150: '150ms',
      250: '250ms',
    },
    transitionTimingFunction: {
      DEFAULT: 'cubic-bezier(0, 0, 0.2, 1)',
      out: 'cubic-bezier(0, 0, 0.2, 1)',
    },

    extend: {
      fontWeight: {
        normal: '400',
        medium: '500',
        semibold: '600',
      },
      maxWidth: {
        chat: '680px',
      },
      // The voice overlay's hero orb. A named size rather than a spacing
      // step: this is a component's own dimension, not a gap between things,
      // and the 4px scale tops out well below what this needs.
      width: {
        orb: '160px',
      },
      height: {
        orb: '160px',
      },
      keyframes: {
        'luna-breathe': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.55', transform: 'scale(1.04)' },
        },
        'luna-pulse-dot': {
          '0%, 100%': { opacity: '0.35' },
          '50%': { opacity: '1' },
        },
        'luna-spin': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        'luna-rise': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        // Concentric rings travelling outward from the voice orb.
        'luna-ring': {
          '0%': { transform: 'scale(1)', opacity: '0.5' },
          '70%': { opacity: '0.12' },
          '100%': { transform: 'scale(1.85)', opacity: '0' },
        },
        'luna-fade': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        'luna-breathe': 'luna-breathe 2s ease-in-out infinite',
        'luna-pulse-dot': 'luna-pulse-dot 1.2s ease-in-out infinite',
        'luna-spin': 'luna-spin 1s linear infinite',
        'luna-rise': 'luna-rise 250ms cubic-bezier(0, 0, 0.2, 1)',
        'luna-ring': 'luna-ring 2.6s cubic-bezier(0, 0, 0.2, 1) infinite',
        'luna-fade': 'luna-fade 250ms cubic-bezier(0, 0, 0.2, 1)',
      },
    },
  },
  plugins: [],
};
