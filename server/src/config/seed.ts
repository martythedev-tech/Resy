import { pool } from './database';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { randomBytes } from 'crypto';

function resolveSeedPassword(envKey: string): string {
  const configured = process.env[envKey];
  if (configured && configured.trim().length >= 8) {
    return configured.trim();
  }
  return randomBytes(18).toString('base64url');
}

async function seed() {
  try {
    dotenv.config();
    const allowSeed = String(process.env.ALLOW_SEED || '').toLowerCase() === 'true';
    if (process.env.NODE_ENV === 'production' && !allowSeed) {
      console.log('⛔ Seed skipped: set ALLOW_SEED=true to run seeds in production.');
      process.exit(0);
    }

    console.log('🌱 Seeding database...');

    // Resolve credentials at runtime (no hardcoded passwords in source).
    const adminPlain = resolveSeedPassword('SEED_ADMIN_PASSWORD');
    const userPlain = resolveSeedPassword('SEED_USER_PASSWORD');
    const managerPlain = resolveSeedPassword('SEED_MANAGER_PASSWORD');
    const adminPassword = await bcrypt.hash(adminPlain, 10);
    try {
      await pool.query(
        `INSERT INTO users (email, password_hash, name, role, department)
         VALUES ($1, $2, $3, $4, $5)`,
        ['admin@company.com', adminPassword, 'Admin User', 'admin', 'IT']
      );
    } catch (e) {
      console.log('Admin user already exists, skipping...');
    }

    // Create regular users
    const userPassword = await bcrypt.hash(userPlain, 10);
    const managerPassword = await bcrypt.hash(managerPlain, 10);
    try {
      await pool.query(
        `INSERT INTO users (email, password_hash, name, role, department)
         VALUES ($1, $2, $3, $4, $5)`,
        ['john@company.com', userPassword, 'John Doe', 'user', 'Engineering']
      );
    } catch (e) {}

    try {
      await pool.query(
        `INSERT INTO users (email, password_hash, name, role, department)
         VALUES ($1, $2, $3, $4, $5)`,
        ['jane@company.com', managerPassword, 'Jane Smith', 'room_manager', 'Sales']
      );
    } catch (e) {}

    // Create buildings
    const buildings = [
      { name: 'Building A', description: 'Main office building - floors 1-4' },
      { name: 'Building B', description: 'Annex building - modern spaces' }
    ];

    for (const building of buildings) {
      try {
        await pool.query(
          `INSERT INTO buildings (name, description)
           VALUES ($1, $2)`,
          [building.name, building.description]
        );
      } catch (e) {}
    }

    // Create rooms (store equipment as JSON string)
    const rooms = [
      { name: 'Orion', building: 'Building A', floor: 2, capacity: 8, equipment: ['TV', 'Zoom', 'Whiteboard'] },
      { name: 'Atlas', building: 'Building A', floor: 3, capacity: 6, equipment: ['Whiteboard', 'Conference Phone'] },
      { name: 'Nova', building: 'Building B', floor: 1, capacity: 12, equipment: ['TV', 'Zoom', 'Projector', 'Whiteboard'] },
      { name: 'Zenith', building: 'Building B', floor: 2, capacity: 10, equipment: ['TV', 'Zoom'] }
    ];

    for (const room of rooms) {
      try {
        await pool.query(
          `INSERT INTO rooms (name, building, floor, capacity, equipment)
           VALUES ($1, $2, $3, $4, $5)`,
          [room.name, room.building, room.floor, room.capacity, JSON.stringify(room.equipment)]
        );
      } catch (e) {}
    }

    // Get admin user ID
    const adminResult = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
    const adminId = (adminResult.rows[0] as any)?.id || 1;

    // Add some sample holidays
    const currentYear = new Date().getFullYear();
    const holidays = [
      { name: 'New Year\'s Day', date: `${currentYear}-01-01`, recurring: 1 },
      { name: 'Independence Day', date: `${currentYear}-07-04`, recurring: 1 },
      { name: 'Christmas Day', date: `${currentYear}-12-25`, recurring: 1 }
    ];

    for (const holiday of holidays) {
      try {
        await pool.query(
          `INSERT INTO holidays (name, date, is_recurring, created_by)
           VALUES ($1, $2, $3, $4)`,
          [holiday.name, holiday.date, holiday.recurring, adminId]
        );
      } catch (e) {}
    }

    console.log('✅ Database seeded successfully!');
    console.log('\n📝 Seed user credentials:');
    console.log(`Admin: admin@company.com / ${adminPlain}`);
    console.log(`User: john@company.com / ${userPlain}`);
    console.log(`Room Manager: jane@company.com / ${managerPlain}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
}

seed();
