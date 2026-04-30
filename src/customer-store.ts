/**
 * Customer identity store — resolve returning customers across platforms.
 *
 * PostgreSQL-backed for production. Persists customer identity across
 * restarts and supports cross-platform identity merge (same person on
 * WhatsApp + Telegram → one customer).
 *
 * Tables: gateway_customers + gateway_customer_identities (created by initConversationStore).
 */

import { randomUUID } from "node:crypto";
import { hasPool, getPool } from "./db.js";

export interface Customer {
  id: string;
  name?: string;
  assignedEmployee?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  interactionCount: number;
}

export interface CustomerIdentity {
  platform: string;
  senderId: string;
  customerId: string;
}

/**
 * Hybrid customer store — uses PostgreSQL when available, falls back to in-memory.
 * This ensures exe-gateway works both with and without a database configured.
 */
export class CustomerStore {
  // In-memory fallback (used when no DB configured)
  private memCustomers = new Map<string, Customer>();
  private memIdentities = new Map<string, string>(); // "platform:senderId" → customerId

  /**
   * Resolve a customer by platform + senderId.
   * Returns existing customer or creates a new one.
   * Uses PostgreSQL when available, otherwise falls back to in-memory.
   */
  resolve(platform: string, senderId: string): Customer {
    if (hasPool()) {
      // Fire async DB resolve — return a temporary customer synchronously.
      // The gateway doesn't await this, so we do fire-and-forget DB persistence
      // and also maintain the in-memory cache for the current session.
      this.resolveDB(platform, senderId).catch((err) => {
        console.error("[customer-store] DB resolve error:", err instanceof Error ? err.message : err);
      });
    }

    // Always maintain in-memory cache for fast synchronous access
    return this.resolveInMemory(platform, senderId);
  }

  /**
   * Async resolve — full DB-backed resolution. Use this when you can await.
   */
  async resolveAsync(platform: string, senderId: string): Promise<Customer> {
    if (hasPool()) {
      return this.resolveDB(platform, senderId);
    }
    return this.resolveInMemory(platform, senderId);
  }

  /** Look up without creating */
  find(platform: string, senderId: string): Customer | undefined {
    const key = `${platform}:${senderId}`;
    const id = this.memIdentities.get(key);
    return id ? this.memCustomers.get(id) : undefined;
  }

  /** Async find from DB */
  async findAsync(platform: string, senderId: string): Promise<Customer | undefined> {
    if (!hasPool()) return this.find(platform, senderId);

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT c.id, c.name, c.assigned_employee, c.first_seen_at, c.last_seen_at, c.interaction_count
         FROM gateway_customers c
         JOIN gateway_customer_identities ci ON ci.customer_id = c.id
         WHERE ci.platform = $1 AND ci.sender_id = $2
         LIMIT 1`,
        [platform, senderId],
      );

      if (result.rows.length === 0) return undefined;
      return rowToCustomer(result.rows[0]);
    } catch {
      return this.find(platform, senderId);
    }
  }

  /** Set customer name */
  async setName(customerId: string, name: string): Promise<void> {
    // In-memory
    const customer = this.memCustomers.get(customerId);
    if (customer) customer.name = name;

    // DB
    if (hasPool()) {
      try {
        const pool = getPool();
        await pool.query(
          `UPDATE gateway_customers SET name = $1 WHERE id = $2`,
          [name, customerId],
        );
      } catch (err) {
        console.error("[customer-store] setName DB error:", err instanceof Error ? err.message : err);
      }
    }
  }

  /** Assign a customer to a specific employee */
  async assignEmployee(customerId: string, employee: string): Promise<void> {
    const customer = this.memCustomers.get(customerId);
    if (customer) customer.assignedEmployee = employee;

    if (hasPool()) {
      try {
        const pool = getPool();
        await pool.query(
          `UPDATE gateway_customers SET assigned_employee = $1 WHERE id = $2`,
          [employee, customerId],
        );
      } catch (err) {
        console.error("[customer-store] assignEmployee DB error:", err instanceof Error ? err.message : err);
      }
    }
  }

  /** Get customer count */
  count(): number {
    return this.memCustomers.size;
  }

  /** Get all customer identities for a customer (cross-platform) */
  async getIdentities(customerId: string): Promise<CustomerIdentity[]> {
    if (!hasPool()) return [];

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT platform, sender_id, customer_id FROM gateway_customer_identities WHERE customer_id = $1`,
        [customerId],
      );
      return result.rows.map((r) => ({
        platform: r.platform,
        senderId: r.sender_id,
        customerId: r.customer_id,
      }));
    } catch {
      return [];
    }
  }

  /** Build greeting context for a returning customer */
  buildContext(customer: Customer): string | undefined {
    if (customer.interactionCount <= 1) return undefined;
    const parts = [`Returning customer (interaction #${customer.interactionCount})`];
    if (customer.name) parts.push(`Name: ${customer.name}`);
    if (customer.assignedEmployee) {
      parts.push(`Assigned to: ${customer.assignedEmployee}`);
    }
    return parts.join(". ");
  }

  // ---------- Private ----------

  private resolveInMemory(platform: string, senderId: string): Customer {
    const key = `${platform}:${senderId}`;
    const existingId = this.memIdentities.get(key);

    if (existingId) {
      const customer = this.memCustomers.get(existingId)!;
      customer.lastSeenAt = new Date().toISOString();
      customer.interactionCount++;
      return customer;
    }

    const customer: Customer = {
      id: randomUUID(),
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      interactionCount: 1,
    };
    this.memCustomers.set(customer.id, customer);
    this.memIdentities.set(key, customer.id);
    return customer;
  }

  private async resolveDB(platform: string, senderId: string): Promise<Customer> {
    const pool = getPool();

    // Check if identity already exists
    const existing = await pool.query(
      `SELECT c.id, c.name, c.assigned_employee, c.first_seen_at, c.last_seen_at, c.interaction_count
       FROM gateway_customers c
       JOIN gateway_customer_identities ci ON ci.customer_id = c.id
       WHERE ci.platform = $1 AND ci.sender_id = $2
       LIMIT 1`,
      [platform, senderId],
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      // Update last seen + increment count
      await pool.query(
        `UPDATE gateway_customers SET last_seen_at = now(), interaction_count = interaction_count + 1 WHERE id = $1`,
        [row.id],
      );

      const customer = rowToCustomer(row);
      customer.interactionCount++;
      customer.lastSeenAt = new Date().toISOString();

      // Update in-memory cache
      this.memCustomers.set(customer.id, customer);
      this.memIdentities.set(`${platform}:${senderId}`, customer.id);
      return customer;
    }

    // New customer — create in DB
    const id = randomUUID();
    const now = new Date().toISOString();

    await pool.query(
      `INSERT INTO gateway_customers (id, first_seen_at, last_seen_at, interaction_count)
       VALUES ($1, $2, $2, 1)`,
      [id, now],
    );

    await pool.query(
      `INSERT INTO gateway_customer_identities (customer_id, platform, sender_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (platform, sender_id) DO NOTHING`,
      [id, platform, senderId],
    );

    const customer: Customer = {
      id,
      firstSeenAt: now,
      lastSeenAt: now,
      interactionCount: 1,
    };

    // Update in-memory cache
    this.memCustomers.set(id, customer);
    this.memIdentities.set(`${platform}:${senderId}`, id);
    return customer;
  }
}

function rowToCustomer(r: Record<string, unknown>): Customer {
  return {
    id: r.id as string,
    name: r.name as string | undefined,
    assignedEmployee: r.assigned_employee as string | undefined,
    firstSeenAt: typeof r.first_seen_at === "string" ? r.first_seen_at : (r.first_seen_at as Date)?.toISOString?.() ?? String(r.first_seen_at),
    lastSeenAt: typeof r.last_seen_at === "string" ? r.last_seen_at : (r.last_seen_at as Date)?.toISOString?.() ?? String(r.last_seen_at),
    interactionCount: r.interaction_count as number,
  };
}
