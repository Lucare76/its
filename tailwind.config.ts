import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "var(--color-bg)",
        surface: "var(--color-surface)",
        "surface-2": "var(--color-surface-2)",
        border: "var(--color-border)",
        text: "var(--color-text)",
        muted: "var(--color-muted)",
        accent: "var(--color-accent)",
        success: "var(--color-success)",
        warning: "var(--color-warning)",
        danger: "var(--color-danger)",
        brand: {
          50: "#f3f9fe",
          100: "#e1eef9",
          200: "#c8def0",
          300: "#a2c2e1",
          400: "#8ab3da",
          500: "#6f9fc8",
          600: "#587faa",
          700: "#486789",
          800: "#3f566e",
          900: "#3e4c59",
          950: "#2f3d49"
        },
        sand: {
          50: "#fff8f3",
          100: "#fde9dd",
          200: "#fadcc9",
          300: "#fad4c0",
          400: "#f6c3aa",
          500: "#eca884"
        },
        mint: {
          50: "#f1fbf9",
          100: "#ddf4f0",
          200: "#cdeee8",
          300: "#b8e1dd",
          400: "#9fd4cf",
          500: "#78b7b0"
        }
      },
      boxShadow: {
        soft: "0 18px 55px rgba(7, 26, 44, 0.08)"
      },
      fontFamily: {
        "serif-display": ['"Iowan Old Style"', '"Palatino Linotype"', '"Book Antiqua"', "serif"],
        sans: ['"Avenir Next"', '"Segoe UI"', "sans-serif"]
      }
    }
  },
  plugins: []
};

export default config;
