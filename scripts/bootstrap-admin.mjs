import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
process.loadEnvFile('.env');

const prisma = new PrismaClient();

async function bootstrapAdmin() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('Error: BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set in .env');
    process.exit(1);
  }

  if (password.length < 10) {
    console.error('Error: Bootstrap admin password must be at least 10 characters long.');
    process.exit(1);
  }

  const saltRounds = 12;
  const passwordHash = await bcrypt.hash(password, saltRounds);

  const existingUser = await prisma.user.findUnique({
    where: { email },
  });

  if (existingUser) {
    await prisma.user.update({
      where: { email },
      data: {
        role: 'ADMIN',
        passwordHash,
        isActive: true,
      },
    });
    console.log(`Admin user "${email}" updated successfully.`);
  } else {
    await prisma.user.create({
      data: {
        email,
        name: 'System Administrator',
        passwordHash,
        role: 'ADMIN',
        isActive: true,
      },
    });
    console.log(`Admin user "${email}" created successfully.`);
  }
}

bootstrapAdmin()
  .catch((e) => {
    console.error('Bootstrap failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
