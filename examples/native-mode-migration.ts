import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HttpModule, HttpService } from 'nestjs-undici-interceptors';
import { lastValueFrom } from 'rxjs';

interface User {
  id: number;
  name: string;
  email: string;
}

/**
 * Example showing migration from v0.3.x (native mode) to v0.4.x (axios-compatible default)
 */
@Injectable()
export class UserService {
  constructor(private readonly httpService: HttpService) {}

  // ❌ OLD WAY (v0.3.x) - This won't work with default v0.4.x
  async getUser_v03(id: number): Promise<User> {
    const response = await lastValueFrom(
      this.httpService.request(`https://jsonplaceholder.typicode.com/users/${id}`)
    );
    
    // This would fail in v0.4.x because response.body is undefined
    // const data = await response.body.json();
    // return data;
    
    // For demo purposes, we'll comment out the above
    console.log('v0.3.x would use response.body.json()');
    return {} as User;
  }

  // ✅ NEW WAY (v0.4.x) - Default axios-compatible mode
  async getUser_v04(id: number): Promise<User> {
    const response = await lastValueFrom(
      this.httpService.request(`https://jsonplaceholder.typicode.com/users/${id}`)
    );
    
    // Data is already parsed!
    return response.data;
  }

  // ✅ ALTERNATIVE: Use convenience methods
  async getUserConvenient(id: number): Promise<User> {
    const response = await lastValueFrom(
      this.httpService.get(`https://jsonplaceholder.typicode.com/users/${id}`)
    );
    
    return response.data;
  }
}

// Option 1: Migrate to new default (recommended)
@Module({
  imports: [
    HttpModule.register({
      timeout: 5000,
      // No special config needed - axios mode is default
    }),
  ],
  providers: [UserService],
})
export class MigratedModule {}

// Option 2: Keep using native mode (if you can't migrate yet)
@Module({
  imports: [
    HttpModule.register({
      timeout: 5000,
      nativeMode: true, // Explicitly enable native mode
    }),
  ],
  providers: [UserService],
})
export class LegacyModule {}

// Option 3: Use the new registerNative() method
@Module({
  imports: [
    HttpModule.registerNative({
      timeout: 5000,
    }),
  ],
  providers: [UserService],
})
export class LegacyModule2 {}

async function demonstrateMigration() {
  console.log('📚 Migration Guide: v0.3.x to v0.4.x\n');
  console.log('=====================================\n');

  // Show the new default behavior
  console.log('1️⃣ New Default Behavior (v0.4.x):');
  console.log('----------------------------------');
  const migratedApp = await NestFactory.create(MigratedModule);
  const migratedService = migratedApp.get(UserService);
  
  const user = await migratedService.getUser_v04(1);
  console.log('✅ User fetched with axios-compatible mode:');
  console.log(`   Name: ${user.name}`);
  console.log(`   Email: ${user.email}`);
  
  const user2 = await migratedService.getUserConvenient(2);
  console.log('\n✅ Using convenient method:');
  console.log(`   Name: ${user2.name}`);
  console.log(`   Email: ${user2.email}`);
  
  await migratedApp.close();

  // Show how to keep native mode
  console.log('\n\n2️⃣ Keeping Native Mode (if needed):');
  console.log('------------------------------------');
  console.log('Add { nativeMode: true } to your config');
  console.log('Or use HttpModule.registerNative()');
  
  console.log('\n\n📋 Quick Migration Checklist:');
  console.log('------------------------------');
  console.log('1. Update response handling:');
  console.log('   - Before: await response.body.json()');
  console.log('   - After:  response.data');
  console.log('\n2. Update status code checks:');
  console.log('   - Before: response.statusCode');
  console.log('   - After:  response.status');
  console.log('\n3. Use convenience methods when possible:');
  console.log('   - httpService.get(), .post(), .put(), etc.');
  console.log('\n4. Error handling is automatic for non-2xx:');
  console.log('   - Add validateStatus if you need custom logic');
  
  console.log('\n\n💡 Benefits of migrating:');
  console.log('-------------------------');
  console.log('• Cleaner, more intuitive API');
  console.log('• Automatic response parsing');
  console.log('• Better error handling');
  console.log('• Easier migration from @nestjs/axios');
  console.log('• Same high performance as before');
}

demonstrateMigration().catch(console.error);