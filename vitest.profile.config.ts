import { defineConfig } from 'vitest/config';

// Явная ручная физическая квалификация; обычный набор проверок корректности не изменён.
export default defineConfig({
  test: {
    include: ['test/server-profile-checkpoint.qualification.ts'],
    environment: 'node',
  },
});
