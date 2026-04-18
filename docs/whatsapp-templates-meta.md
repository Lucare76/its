# Template WhatsApp "Prima di partire" — Ischia Transfer Service
# Da sottomettere su Meta Business Manager > WhatsApp > Gestione template

## Istruzioni invio a Meta
1. Accedi a business.facebook.com
2. Vai su WhatsApp > Gestione template > Crea template
3. Categoria: **UTILITY**
4. Copia il testo del Body esattamente come scritto (con {{1}}, {{2}} ecc.)
5. Footer: `Ischia Transfer Service • 0813331053`
6. Bottone tipo PHONE_NUMBER: testo `📞 Chiama assistenza`, numero `+390813331053`
7. Ogni template va sottomesso DUE VOLTE: una versione IT e una EN (stesso nome, lingue diverse)
8. Template Bus (`its_qr_bus`): aggiungere Header di tipo IMAGE (il sistema invia il QR dinamicamente)

---

# VERSIONI ITALIANE (lingua: it)

## 1. `its_info_aeroporto` — Lingua: Italiano
**Trigger:** booking_service_kind = transfer_airport_hotel, prefisso +39

**Body:**
```
🛬 Gentile {{1}},

benvenuto! Ecco tutto ciò che ti serve sapere per il tuo arrivo.

*In aeroporto:*
📍 Il nostro assistente ti aspetta in sala arrivi con il cartello Ischia Transfer Service.

*Al porto:*
🚢 Ti accompagniamo all'imbarco per la traversata verso Ischia.

*A Ischia:*
🏝 All'arrivo trovi di nuovo il nostro assistente con lo stesso cartello.

✅ Siamo pronti ad accoglierti!
```
**Variabili:** {{1}} = nome cliente

---

## 2. `its_info_stazione` — Lingua: Italiano
**Trigger:** booking_service_kind = transfer_train_hotel / transfer_station_hotel, prefisso +39

**Body:**
```
🚉 Gentile {{1}},

benvenuto! Ecco tutto ciò che ti serve sapere per il tuo arrivo in stazione.

*In stazione:*
📍 Il nostro assistente ti aspetta con il cartello Ischia Transfer Service.

*Al porto:*
🚢 Ti accompagniamo all'imbarco per la traversata verso Ischia.

*A Ischia:*
🏝 All'arrivo trovi di nuovo il nostro assistente con lo stesso cartello.

✅ Siamo pronti ad accoglierti!
```
**Variabili:** {{1}} = nome cliente

---

## 3. `its_info_medmar` — Lingua: Italiano
**Trigger:** booking_service_kind = formula_medmar_napoli / formula_medmar_pozzuoli, prefisso +39

**Body:**
```
⛴ Gentile {{1}},

sei in partenza da {{2}}? Ecco le informazioni utili per il tuo viaggio.

*All'arrivo a Ischia:*
📍 Il nostro assistente ti aspetta allo sbarco con il cartello Ischia Transfer Service.

*Per il rientro:*
📱 Riceverai via WhatsApp orario e dettagli del trasferimento verso {{2}}.

✅ Buon viaggio!
```
**Variabili:** {{1}} = nome cliente, {{2}} = "Napoli Beverello" oppure "Pozzuoli"

---

## 4. `its_info_snav` — Lingua: Italiano
**Trigger:** booking_service_kind = formula_snav, prefisso +39

**Body:**
```
⛴ Gentile {{1}},

sei in arrivo con SNAV? Ecco le informazioni utili per il tuo sbarco.

*A Casamicciola:*
📍 Recati alle biglietterie SNAV — il nostro assistente ti aspetta con il cartello Ischia Transfer Service.

*Per il rientro:*
📱 Riceverai via WhatsApp orario e dettagli del trasferimento.

✅ Buon viaggio!
```
**Variabili:** {{1}} = nome cliente

---

## 5. `its_qr_bus` — Lingua: Italiano
**Trigger:** booking_service_kind = bus_city_hotel, prefisso +39
**Header:** IMAGE (QR code dinamico — inviato dal sistema)

**Body:**
```
🚌 Gentile {{1}},

il tuo QR code per salire sul bus è qui sopra.

*Come funziona:*
📍 Mostra il QR all'autista al momento della salita.
🗓 Il servizio è previsto per il {{2}}.

✅ Salva questo messaggio — ti servirà il giorno del viaggio!
```
**Variabili:** {{1}} = nome cliente, {{2}} = data servizio (es. 2025-07-15)

---

# VERSIONI INGLESI (lingua: en) — per numeri con prefisso non +39

## 6. `its_info_aeroporto_en` — Lingua: English
**Trigger:** booking_service_kind = transfer_airport_hotel, prefisso non +39

**Body:**
```
🛬 Dear {{1}},

welcome! Here is everything you need to know for your arrival.

*At the airport:*
📍 Our assistant will be waiting for you in the arrivals hall with an Ischia Transfer Service sign.

*At the port:*
🚢 We will accompany you to the boarding area for the crossing to Ischia.

*In Ischia:*
🏝 Upon arrival, our assistant will be waiting again with the same sign.

✅ We are ready to welcome you!
```
**Variables:** {{1}} = customer name

---

## 7. `its_info_stazione_en` — Lingua: English
**Trigger:** booking_service_kind = transfer_train_hotel / transfer_station_hotel, prefisso non +39

**Body:**
```
🚉 Dear {{1}},

welcome! Here is everything you need to know for your arrival at the train station.

*At the station:*
📍 Our assistant will be waiting for you with an Ischia Transfer Service sign.

*At the port:*
🚢 We will accompany you to the boarding area for the crossing to Ischia.

*In Ischia:*
🏝 Upon arrival, our assistant will be waiting again with the same sign.

✅ We are ready to welcome you!
```
**Variables:** {{1}} = customer name

---

## 8. `its_info_medmar_en` — Lingua: English
**Trigger:** booking_service_kind = formula_medmar_napoli / formula_medmar_pozzuoli, prefisso non +39

**Body:**
```
⛴ Dear {{1}},

departing from {{2}}? Here is the information for your trip.

*Upon arrival in Ischia:*
📍 Our assistant will be waiting for you at the dock with an Ischia Transfer Service sign.

*For your return:*
📱 You will receive via WhatsApp the time and details of the transfer to {{2}}.

✅ Have a great trip!
```
**Variables:** {{1}} = customer name, {{2}} = "Naples (Beverello)" or "Pozzuoli"

---

## 9. `its_info_snav_en` — Lingua: English
**Trigger:** booking_service_kind = formula_snav, prefisso non +39

**Body:**
```
⛴ Dear {{1}},

arriving with SNAV? Here is what you need to know upon disembarkation.

*At Casamicciola:*
📍 Please go to the SNAV ticket office — our assistant will be waiting with an Ischia Transfer Service sign.

*For your return:*
📱 You will receive via WhatsApp the time and details of the transfer.

✅ Have a great trip!
```
**Variables:** {{1}} = customer name

---

## 10. `its_qr_bus_en` — Lingua: English
**Trigger:** booking_service_kind = bus_city_hotel, prefisso non +39
**Header:** IMAGE (dynamic QR code — sent by the system)

**Body:**
```
🚌 Dear {{1}},

your QR code to board the bus is shown above.

*How it works:*
📍 Show the QR to the driver when boarding.
🗓 Your service is scheduled for {{2}}.

✅ Save this message — you will need it on the day of your trip!
```
**Variables:** {{1}} = customer name, {{2}} = service date (e.g. 2025-07-15)

---

## Note anti-ban
- Categoria UTILITY: approvazione rapida, nessun limite giornaliero di invio
- Emoji e testo strutturato: meta accetta emoji in UTILITY se il contenuto è chiaro e non promozionale
- Spread automatico: arrivi domenica distribuiti su lunedì-giovedì (3-6gg prima) via hash del service_id
- Rilevamento lingua automatico: prefisso +39 = italiano, altri = inglese
- Deduplicazione integrata: ogni cliente riceve il messaggio al massimo una volta per prenotazione (kind=info_3d)
- Bottone PHONE_NUMBER: i bottoni non contano come "call to action" promozionale in UTILITY
