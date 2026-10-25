// Shared migration registry. Feature modules register migrations from their own files
// (lib/migrations/*.mjs); they are applied in id order. Never edit an applied migration.
export const migrations = [];
export const migration = (id, up) => {
  if (migrations.some(m => m.id === id)) throw new Error(`Duplicate migration id ${id}`);
  migrations.push({ id, up });
  migrations.sort((a, b) => a.id.localeCompare(b.id));
};
