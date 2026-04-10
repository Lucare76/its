require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');

async function main() {
  const operatorEmail = process.env.OPERATOR_EMAIL || 'lucarenna76@gmail.com';
  const existing = await prisma.user.findUnique({ where: { email: operatorEmail } });

  if (!existing) {
    const passwordHash = await bcrypt.hash('operator123', 10);
    await prisma.user.create({
      data: {
        name: 'Operatore Demo',
        email: operatorEmail,
        passwordHash,
        role: 'OPERATOR',
      },
    });
  }

  const hotels = [
    { name: 'Hotel Ischia Porto', address: 'Via Roma 1, Ischia', latitude: 40.7378, longitude: 13.9474 },
    { name: 'Hotel Forio Mare', address: 'Via Marina 8, Forio', latitude: 40.7342, longitude: 13.8578 },
    { name: 'Hotel Casamicciola Terme', address: 'Corso Luigi Manzi 4, Casamicciola', latitude: 40.7473, longitude: 13.9122 },
  ];

  for (const hotel of hotels) {
    const existingHotel = await prisma.hotel.findFirst({
      where: {
        name: hotel.name,
        address: hotel.address,
      },
    });

    if (!existingHotel) {
      await prisma.hotel.create({ data: hotel });
    }
  }

  const vehicles = [
    { name: 'Kassbohrer Setra 315 HDH', capacity: 55, type: 'BUS' },
    { name: 'Mercedes O404', capacity: 55, type: 'BUS' },
    { name: 'Mercedes 350 SHD', capacity: 53, type: 'BUS' },
    { name: 'Kassbohrer Setra 210 HD', capacity: 39, type: 'BUS' },
    { name: 'Mercedes 413', capacity: 17, type: 'MINIBUS' },
    { name: 'Mercedes 312', capacity: 12, type: 'MINIBUS' },
    { name: 'Mercedes E270', capacity: 4, type: 'CAR' },
    { name: 'Mercedes Vito', capacity: 8, type: 'VAN' },
    { name: 'Mercedes V220', capacity: 7, type: 'VAN' },
    { name: 'Mercedes E 270', capacity: 5, type: 'CAR' },
  ];

  for (const vehicle of vehicles) {
    const existingVehicle = await prisma.vehicle.findUnique({
      where: { name: vehicle.name },
    });

    if (!existingVehicle) {
      await prisma.vehicle.create({ data: vehicle });
    }
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
