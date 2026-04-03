const italianQuotes = [
  "Buongiorno! Inizia la giornata con energia e positività.",
  "Ogni giorno è una nuova opportunità per eccellere.",
  "Il successo è la somma di piccoli sforzi ripetuti giorno dopo giorno.",
  "Sii la versione migliore di te stesso oggi.",
  "La perseveranza porta al traguardo.",
  "Sorridi, oggi sarà una grande giornata!",
  "Concentrati sui tuoi obiettivi e vai avanti.",
  "La tua energia positiva crea il tuo futuro.",
  "Ogni sfida è un'opportunità di crescita.",
  "Buona fortuna per una giornata produttiva!",
  "Quello che fai oggi può migliorare il domani.",
  "Non aspettare il momento perfetto, prendi il momento e rendilo perfetto.",
  "Credi in te stesso e gli altri crederanno in te.",
  "Il tuo tempo è limitato, non sprecarla vivendo la vita di qualcun altro.",
  "Fare la differenza inizia con una singola azione.",
  "La motivazione è ciò che ti inizia, l'abitudine è ciò che ti continua.",
  "Oggi è il primo giorno del resto della tua vita.",
  "Sei più forte di quanto pensi.",
  "Ogni maestro è stato una volta uno studente.",
  "La tua debolezza di oggi è la forza di domani."
];

export async function getMotivationalQuote(): Promise<string> {
  // Seleziona una frase casuale dall'array italiano
  const randomIndex = Math.floor(Math.random() * italianQuotes.length);
  return italianQuotes[randomIndex];
}