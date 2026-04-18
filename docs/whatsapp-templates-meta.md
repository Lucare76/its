# Template WhatsApp "Prima di partire" — Ischia Transfer Service
# Da sottomettere su Meta Business Manager > WhatsApp > Gestione template

## Istruzioni invio a Meta
1. Accedi a business.facebook.com
2. Vai su WhatsApp > Gestione template > Crea template
3. Categoria: UTILITY
4. Lingua: Italiano (it)
5. Copia il testo del Body esattamente come scritto (con {{1}}, {{2}})
6. Nessun Header, nessun Footer, nessun bottone — solo Body

---

## 1. `its_info_aeroporto`
**Trigger:** servizi con booking_service_kind = transfer_airport_hotel

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

**Variabili:**
- {{1}} = nome cliente (es. "Mario Rossi")

---

## 2. `its_info_stazione`
**Trigger:** servizi con booking_service_kind = transfer_train_hotel

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

**Variabili:**
- {{1}} = nome cliente (es. "Mario Rossi")

---

## 3. `its_info_medmar`
**Trigger:** servizi con booking_service_kind = formula_medmar_napoli OPPURE formula_medmar_pozzuoli

**Body:**
```
Gentile {{1}},

in vista della sua partenza da {{2}}, ecco le informazioni utili:

1. Allo sbarco a Ischia troverà il nostro assistente con il cartello Ischia Transfer Service.

2. Il giorno della partenza da Ischia riceverà via WhatsApp l'orario e i dettagli del trasferimento verso {{2}}.

Per qualsiasi necessità siamo a sua disposizione.
Ischia Transfer Service
```

**Variabili:**
- {{1}} = nome cliente (es. "Mario Rossi")
- {{2}} = porto di imbarco ("Napoli Beverello" oppure "Pozzuoli")

---

## 4. `its_info_snav`
**Trigger:** servizi con booking_service_kind = formula_snav

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

**Variabili:**
- {{1}} = nome cliente (es. "Mario Rossi")

---

## Note anti-ban
- Categoria UTILITY (non MARKETING): tasso di approvazione molto più alto, nessun limite giornaliero
- Nessun link, nessun URL shortener, nessun numero di telefono nel body
- Nessuna emoji (aumentano il rischio di rifiuto)
- Invio automatico 3 giorni prima dell'arrivo → ~57 messaggi/giorno su 400 arrivi/settimana
- Deduplicazione integrata nel sistema: ogni cliente riceve il template al massimo una volta per prenotazione
