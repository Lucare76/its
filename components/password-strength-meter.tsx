"use client";

import { useState, useEffect } from "react";

interface PasswordStrengthProps {
  password: string;
  showLabel?: boolean;
}

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  percentage: number;
}

function calculateStrength(password: string): PasswordStrength {
  let score = 0;

  if (!password) return { score: 0, label: "Non specificata", percentage: 0 };

  // Lunghezza
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;

  // Maiuscole
  if (/[A-Z]/.test(password)) score += 1;

  // Minuscole
  if (/[a-z]/.test(password)) score += 1;

  // Numeri
  if (/\d/.test(password)) score += 1;

  // Caratteri speciali
  if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) score += 1;

  const normalizedScore = Math.min(score > 4 ? 4 : (score > 3 ? 3 : (score > 2 ? 2 : (score > 1 ? 1 : 0))), 4) as 0 | 1 | 2 | 3 | 4;

  const labels = ["Molto debole", "Debole", "Media", "Forte", "Molto forte"];
  const percentages = [20, 40, 60, 80, 100];

  return {
    score: normalizedScore,
    label: labels[normalizedScore],
    percentage: percentages[normalizedScore]
  };
}

export function PasswordStrengthMeter({ password, showLabel = true }: PasswordStrengthProps) {
  const [strength, setStrength] = useState<PasswordStrength>({ score: 0, label: "Non specificata", percentage: 0 });

  useEffect(() => {
    setStrength(calculateStrength(password));
  }, [password]);

  const colorMap = {
    0: "bg-gray-300",
    1: "bg-red-500",
    2: "bg-orange-500",
    3: "bg-yellow-500",
    4: "bg-green-500"
  };

  const textColorMap = {
    0: "text-gray-600",
    1: "text-red-600",
    2: "text-orange-600",
    3: "text-yellow-600",
    4: "text-green-600"
  };

  if (!password) return null;

  return (
    <div className="mt-2 space-y-1">
      <div className="h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${colorMap[strength.score]}`}
          style={{ width: `${strength.percentage}%` }}
        />
      </div>
      {showLabel && (
        <p className={`text-xs font-medium ${textColorMap[strength.score]}`}>
          Forza: {strength.label}
        </p>
      )}
    </div>
  );
}

export function usePasswordStrength(password: string): PasswordStrength {
  return calculateStrength(password);
}
