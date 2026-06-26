-- Allinea i nomi in hotel_pickup_times con quelli effettivi della tabella hotels
-- per far funzionare il JOIN nella view ops_bus_allocation_details

-- FORIO
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL TERME COLELLA' WHERE upper(trim(hotel_name)) = 'COLELLA';
UPDATE hotel_pickup_times SET hotel_name = 'ROYAL PALM HOTEL TERME' WHERE upper(trim(hotel_name)) = 'ROYAL PALM';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL PUNTA DEL SOLE' WHERE upper(trim(hotel_name)) = 'PUNTA DEL SOLE';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL CARLO MAGNO' WHERE upper(trim(hotel_name)) = 'CARLO MAGNO';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL ZI CARMELA' WHERE upper(trim(hotel_name)) = 'ZI CARMELA';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL TERME TRITONE' WHERE upper(trim(hotel_name)) = 'TRITONE';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL LORD BYRON' WHERE upper(trim(hotel_name)) = 'LORD BYRON';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL EDEN PARK' WHERE upper(trim(hotel_name)) = 'EDEN PARK';
UPDATE hotel_pickup_times SET hotel_name = 'PARCO HOTEL TERME VILLA TERESA' WHERE upper(trim(hotel_name)) = 'VILLA TERESA';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL VILLA MIRALISA' WHERE upper(trim(hotel_name)) = 'VILLA MIRALISA';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL LA GINESTRA' WHERE upper(trim(hotel_name)) = 'LA GINESTRA';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL TRAMONTO D''ORO' WHERE upper(trim(hotel_name)) = 'TRAMONTO D''ORO';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL GALIDON' WHERE upper(trim(hotel_name)) = 'GALIDON';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL SAN NICOLA' WHERE upper(trim(hotel_name)) = 'B&B SAN NICOLA';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL BAIA DELLE SIRENE' WHERE upper(trim(hotel_name)) = 'BAIA DELLE SIRENE';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL CASTIGLIONE VILLAGE' WHERE upper(trim(hotel_name)) = 'CASTIGLIONE VILLAGE';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL LA ROSA' WHERE upper(trim(hotel_name)) = 'LA ROSA';
UPDATE hotel_pickup_times SET hotel_name = 'PARK HOTEL IMPERIAL' WHERE upper(trim(hotel_name)) = 'PARK IMPERIAL';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL SORRISO' WHERE upper(trim(hotel_name)) = 'SORRISO';

-- BARANO
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL SAINT RAPHAEL' WHERE upper(trim(hotel_name)) = 'SAINT RAPHAEL';

-- ISCHIA
UPDATE hotel_pickup_times SET hotel_name = 'HTL BRISTOL' WHERE upper(trim(hotel_name)) = 'BRISTOL';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL TERME FELIX' WHERE upper(trim(hotel_name)) = 'FELIX';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL TERME PRESIDENT' WHERE upper(trim(hotel_name)) = 'PRESIDENT';
UPDATE hotel_pickup_times SET hotel_name = 'GRAND HOTEL DELLE TERME RE FERDINANDO' WHERE upper(trim(hotel_name)) = 'RE FERDINANDO';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL TIRRENIA' WHERE upper(trim(hotel_name)) = 'TIRRENIA';
UPDATE hotel_pickup_times SET hotel_name = 'CENTRAL PARK TERME' WHERE upper(trim(hotel_name)) = 'CENTRAL PARK';
UPDATE hotel_pickup_times SET hotel_name = 'SAN VALENTINO TERME' WHERE upper(trim(hotel_name)) = 'SAN VALENTINO';
UPDATE hotel_pickup_times SET hotel_name = 'Hotel Bellevue' WHERE upper(trim(hotel_name)) = 'BELLEVUE';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL DON PEPE' WHERE upper(trim(hotel_name)) = 'DON PEPE';
UPDATE hotel_pickup_times SET hotel_name = 'GRAND HOTEL TERME DI AUGUSTO' WHERE upper(trim(hotel_name)) = 'AUGUSTO';
UPDATE hotel_pickup_times SET hotel_name = 'ISOLA VERDE HOTEL & THERMAL SPA' WHERE upper(trim(hotel_name)) = 'ISOLA VERDE';
UPDATE hotel_pickup_times SET hotel_name = 'Hotel Continental Terme' WHERE upper(trim(hotel_name)) = 'CONTINENTAL TERME';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL CONTINENTAL MARE' WHERE upper(trim(hotel_name)) = 'CONTINENTAL MARE';
UPDATE hotel_pickup_times SET hotel_name = 'ARAGONA PALACE HOTEL & SPA' WHERE upper(trim(hotel_name)) = 'ARAGONA';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL ROYAL TERME' WHERE upper(trim(hotel_name)) = 'ROYAL TERME';
UPDATE hotel_pickup_times SET hotel_name = 'GRAND HOTEL ISCHIA & LIDO-AURUM HOTELS' WHERE upper(trim(hotel_name)) = 'AURUM';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL FLORIDIANA TERME' WHERE upper(trim(hotel_name)) = 'FLORIDIANA';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL TERME ORIENTE' WHERE upper(trim(hotel_name)) = 'ORIENTE';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL PARCO AURORA' WHERE upper(trim(hotel_name)) = 'PARCO AURORA';

-- LACCO AMENO
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL VILLA SVIZZERA' WHERE upper(trim(hotel_name)) = 'VILLA SVIZZERA';
UPDATE hotel_pickup_times SET hotel_name = 'ALBERGO TERME SAN LORENZO' WHERE upper(trim(hotel_name)) = 'SAN LORENZO';

-- CASAMICCIOLA T
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL CRISTALLO' WHERE upper(trim(hotel_name)) = 'CRISTALLO';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL GRAN PARADISO' WHERE upper(trim(hotel_name)) = 'GRAN PARADISO';
UPDATE hotel_pickup_times SET hotel_name = 'HOTEL STELLA MARIS' WHERE upper(trim(hotel_name)) = 'STELLA MARIS';
