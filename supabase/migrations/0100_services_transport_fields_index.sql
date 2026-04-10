-- Nessuna colonna da aggiungere: transport_mode e outbound_time esistono già.
-- Questa migration è un no-op documentativo per tracciare che i campi
-- vengono ora usati anche dal workflow agency_review.
-- transport_mode: "train"|"hydrofoil"|"ferry"|"road_transfer"|"bus"|"unknown"
-- outbound_time:  text (orario mezzo, es. "14:30")
select 1;
