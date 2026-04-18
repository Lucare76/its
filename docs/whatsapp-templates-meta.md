# Template WhatsApp "Prima di partire" — Ischia Transfer Service
# Da sottomettere su Meta Business Manager > WhatsApp > Gestione template

## Istruzioni invio a Meta
1. Accedi a business.facebook.com
2. Vai su WhatsApp > Gestione template > Crea template
3. Categoria: UTILITY
4. Copia il testo del Body esattamente come scritto (con {{1}}, {{2}})
5. Nessun Header, nessun Footer, nessun bottone — solo Body
6. Ogni template va sottomesso DUE VOLTE: una versione IT e una EN (stesso nome, lingue diverse)

---

# VERSIONI ITALIANE (lingua: it)

## 1. `its_info_aeroporto` — Lingua: Italiano
**Trigger:** booking_service_kind = transfer_airport_hotel, prefisso +39

**Body:**
```
Gentile {{1}},

in vista del suo arrivo, ecco le informazioni per il ritiro:

1. Nella hall degli arrivi in aeroporto troverà il nostro assistente con il cartello Ischia Transfer Service.

2. Il nostro team la accompagnerà al porto di imbarco per la navigazione verso Ischia.

3. Allo sbarco a Ischia, il nostro assistente la attenderà con lo stesso cartello.

Per qualsiasi necessità siamo a sua disposizione.
Ischia Transfer Service
```
**Variabili:** {{1}} = nome cliente

---

## 2. `its_info_stazione` — Lingua: Italiano
**Trigger:** booking_service_kind = transfer_train_hotel, prefisso +39

**Body:**
```
Gentile {{1}},

in vista della sua partenza, ecco le informazioni per il ritiro in stazione:

1. Alla stazione troverà il nostro assistente con il cartello Ischia Transfer Service.

2. Il nostro team la accompagnerà al porto di imbarco per la navigazione verso Ischia.

3. Allo sbarco a Ischia, il nostro assistente la attenderà con lo stesso cartello.

Per qualsiasi necessità siamo a sua disposizione.
Ischia Transfer Service
```
**Variabili:** {{1}} = nome cliente

---

## 3. `its_info_medmar` — Lingua: Italiano
**Trigger:** booking_service_kind = formula_medmar_napoli / formula_medmar_pozzuoli, prefisso +39

**Body:**
```
Gentile {{1}},

in vista della sua partenza da {{2}}, ecco le informazioni utili:

1. Allo sbarco a Ischia troverà il nostro assistente con il cartello Ischia Transfer Service.

2. Il giorno della partenza da Ischia riceverà via WhatsApp l'orario e i dettagli del trasferimento verso {{2}}.

Per qualsiasi necessità siamo a sua disposizione.
Ischia Transfer Service
```
**Variabili:** {{1}} = nome cliente, {{2}} = "Napoli Beverello" oppure "Pozzuoli"

---

## 4. `its_info_snav` — Lingua: Italiano
**Trigger:** booking_service_kind = formula_snav, prefisso +39

**Body:**
```
Gentile {{1}},

in vista della sua partenza con SNAV, ecco le informazioni utili:

1. Allo sbarco a Casamicciola si rechi presso le biglietterie SNAV.

2. Alle biglietterie troverà il nostro assistente con il cartello Ischia Transfer Service.

3. Il giorno della partenza da Ischia riceverà via WhatsApp l'orario e i dettagli del trasferimento.

Per qualsiasi necessità siamo a sua disposizione.
Ischia Transfer Service
```
**Variabili:** {{1}} = nome cliente

---

# VERSIONI INGLESI (lingua: en) — per numeri con prefisso non +39

## 5. `its_info_aeroporto_en` — Lingua: English
**Trigger:** booking_service_kind = transfer_airport_hotel, prefisso non +39

**Body:**
```
Dear {{1}},

here is the information for your arrival at the airport:

1. In the arrivals hall, our assistant will be waiting for you with an Ischia Transfer Service sign.

2. Our team will transfer you to the port for the crossing to Ischia.

3. Upon arrival in Ischia, our assistant will be waiting for you with the same sign.

We are at your disposal for any questions.
Ischia Transfer Service
```
**Variables:** {{1}} = customer name

---

## 6. `its_info_stazione_en` — Lingua: English
**Trigger:** booking_service_kind = transfer_train_hotel, prefisso non +39

**Body:**
```
Dear {{1}},

here is the information for your departure from the train station:

1. At the station, our assistant will be waiting for you with an Ischia Transfer Service sign.

2. Our team will transfer you to the port for the crossing to Ischia.

3. Upon arrival in Ischia, our assistant will be waiting for you with the same sign.

We are at your disposal for any questions.
Ischia Transfer Service
```
**Variables:** {{1}} = customer name

---

## 7. `its_info_medmar_en` — Lingua: English
**Trigger:** booking_service_kind = formula_medmar_napoli / formula_medmar_pozzuoli, prefisso non +39

**Body:**
```
Dear {{1}},

here is the information for your departure from {{2}}:

1. Upon arrival in Ischia, our assistant will be waiting for you with an Ischia Transfer Service sign.

2. On the day of your departure from Ischia, you will receive via WhatsApp the time and details of the transfer to {{2}}.

We are at your disposal for any questions.
Ischia Transfer Service
```
**Variables:** {{1}} = customer name, {{2}} = "Naples (Beverello)" or "Pozzuoli"

---

## 8. `its_info_snav_en` — Lingua: English
**Trigger:** booking_service_kind = formula_snav, prefisso non +39

**Body:**
```
Dear {{1}},

here is the information for your SNAV departure:

1. Upon arrival at Casamicciola, please go to the SNAV ticket office.

2. At the SNAV ticket office, our assistant will be waiting for you with an Ischia Transfer Service sign.

3. On the day of your departure from Ischia, you will receive via WhatsApp the time and details of the transfer.

We are at your disposal for any questions.
Ischia Transfer Service
```
**Variables:** {{1}} = customer name

---

## Note anti-ban
- Categoria UTILITY: approvazione rapida, nessun limite giornaliero di invio
- Nessun link, nessun emoji, nessun numero di telefono nel body
- Spread automatico: gli arrivi di domenica vengono distribuiti su lunedi-giovedi (3-6gg prima)
- Rilevamento lingua automatico: prefisso +39 = italiano, altri = inglese
- Deduplicazione integrata: ogni cliente riceve il messaggio al massimo una volta per prenotazione
