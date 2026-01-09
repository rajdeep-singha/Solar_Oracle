import { Aptos, AptosConfig, Network, Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";
import axios from "axios";
import * as dotenv from "dotenv";
import dns from "dns";
import http from "http";
import https from "https";

// Force IPv4 first to avoid IPv6 connection issues
dns.setDefaultResultOrder('ipv4first');

dotenv.config();

// Configuration
const NREL_API_KEY = process.env.NREL_API_KEY!;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY!;
const MODULE_ADDRESS = process.env.MODULE_ADDRESS!;
const NETWORK = process.env.NETWORK || "devnet";

// Create HTTP agents with IPv4 forced
const httpAgent = new http.Agent({ 
  keepAlive: true, 
  family: 4,
  timeout: 60000,
});

const httpsAgent = new https.Agent({ 
  keepAlive: true, 
  family: 4,
  timeout: 60000,
  rejectUnauthorized: true,
});

// Initialize Aptos client
const config = new AptosConfig({ 
  network: NETWORK as Network 
});
const aptos = new Aptos(config);

// Oracle account (from private key)
const privateKey = new Ed25519PrivateKey(ORACLE_PRIVATE_KEY);
const oracleAccount = Account.fromPrivateKey({ privateKey });

console.log(`🔑 Oracle Address: ${oracleAccount.accountAddress.toString()}`);

// NREL API Types
interface NRELResponse {
  outputs: {
    avg_dni: { annual: number };
    avg_ghi: { annual: number };
    avg_lat_tilt: { annual: number };
  };
}

interface SolarData {
  latitude: number;
  longitude: number;
  dni: number;  // Direct Normal Irradiance (kWh/m²/day * 100)
  ghi: number;  // Global Horizontal Irradiance (kWh/m²/day * 100)
  lat_tilt: number; // Latitude Tilt (kWh/m²/day * 100)
  timestamp: number;
}

// Coordinate encoding for u64 compatibility
// Move uses u64 (unsigned), so we shift coordinates to positive range:
// Latitude: -90 to +90 → add 90 → 0 to 180
// Longitude: -180 to +180 → add 180 → 0 to 360
function encodeLatitude(lat: number): number {
  return Math.floor((lat + 90) * 1000000);
}

function encodeLongitude(lon: number): number {
  return Math.floor((lon + 180) * 1000000);
}

/**
 * Fetch solar resource data from NREL API
 */
async function fetchSolarData(lat: number, lon: number): Promise<SolarData> {
  console.log(`📡 Fetching NREL data for lat: ${lat}, lon: ${lon}`);
  console.log(`🔑 Using API key: ${NREL_API_KEY ? NREL_API_KEY.substring(0, 8) + '...' : 'NOT SET'}`);
  
  try {
    const response = await axios.get<NRELResponse>(
      "https://developer.nrel.gov/api/solar/solar_resource/v1.json",
      {
        params: {
          api_key: NREL_API_KEY,
          lat: lat,
          lon: lon,
        },
        timeout: 60000,  // 60 second timeout
        httpAgent: httpAgent,
        httpsAgent: httpsAgent,
        proxy: false,    // Disable proxy
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      }
    );

    const outputs = response.data.outputs;
    
    // Convert to integers (multiply by 100 to preserve 2 decimal places)
    // Move doesn't support floats, so we store as u64
    // Coordinates are shifted to positive range for u64 compatibility
    const solarData: SolarData = {
      latitude: encodeLatitude(lat),    // Shifted: lat + 90
      longitude: encodeLongitude(lon),  // Shifted: lon + 180
      dni: Math.floor(outputs.avg_dni.annual * 100),
      ghi: Math.floor(outputs.avg_ghi.annual * 100),
      lat_tilt: Math.floor(outputs.avg_lat_tilt.annual * 100),
      timestamp: Math.floor(Date.now() / 1000),
    };

    console.log(`✅ NREL Data:`, {
      dni: `${outputs.avg_dni.annual} kWh/m²/day`,
      ghi: `${outputs.avg_ghi.annual} kWh/m²/day`,
      lat_tilt: `${outputs.avg_lat_tilt.annual} kWh/m²/day`,
    });

    return solarData;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(`❌ NREL API Error:`, {
        code: error.code,
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
      throw new Error(`NREL API Error (${error.code}): ${error.message}`);
    }
    throw error;
  }
}

/**
 * Push solar data on-chain to Aptos
 */
async function pushToChain(data: SolarData): Promise<string> {
  try {
    console.log(`📤 Pushing to Aptos blockchain...`);

    const transaction = await aptos.transaction.build.simple({
      sender: oracleAccount.accountAddress,
      data: {
        function: `${MODULE_ADDRESS}::solar_oracle::update_solar_data`,
        functionArguments: [
          data.latitude,
          data.longitude,
          data.dni,
          data.ghi,
          data.lat_tilt,
          data.timestamp,
        ],
      },
    });

    const committedTxn = await aptos.signAndSubmitTransaction({
      signer: oracleAccount,
      transaction,
    });

    const executedTransaction = await aptos.waitForTransaction({
      transactionHash: committedTxn.hash,
    });

    console.log(`✅ Transaction committed: ${committedTxn.hash}`);
    console.log(`   Gas used: ${executedTransaction.gas_used}`);

    return committedTxn.hash;
  } catch (error) {
    console.error(`❌ Transaction failed:`, error);
    throw error;
  }
}

/**
 * Read solar data from blockchain
 */
async function readFromChain(lat: number, lon: number): Promise<void> {
  try {
    const latEncoded = encodeLatitude(lat);
    const lonEncoded = encodeLongitude(lon);

    console.log(`📖 Reading on-chain data for (${lat}, ${lon})`);
    console.log(`   Encoded: lat=${latEncoded}, lon=${lonEncoded}`);

    const resource = await aptos.getAccountResource({
      accountAddress: MODULE_ADDRESS,
      resourceType: `${MODULE_ADDRESS}::solar_oracle::SolarRegistry`,
    });

    console.log(`📖 Registry data:`, resource);
  } catch (error) {
    console.error(`❌ Failed to read on-chain data:`, error);
  }
}

/**
 * Main oracle update cycle
 */
async function updateOracle(locations: Array<{ lat: number; lon: number }>) {
  console.log(`\n🚀 Starting Oracle Update Cycle`);
  console.log(`   Network: ${NETWORK}`);
  console.log(`   Module: ${MODULE_ADDRESS}`);
  console.log(`   Locations: ${locations.length}`);

  for (const loc of locations) {
    try {
      console.log(`\n📍 Processing location: ${loc.lat}, ${loc.lon}`);
      
      // Fetch from NREL
      const solarData = await fetchSolarData(loc.lat, loc.lon);
      
      // Push to Aptos
      const txHash = await pushToChain(solarData);
      
      console.log(`✅ Successfully updated location ${loc.lat}, ${loc.lon}`);
      
      // Wait 2 seconds between updates to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      console.error(`❌ Failed to update location ${loc.lat}, ${loc.lon}:`, error);
    }
  }

  console.log(`\n✅ Oracle update cycle completed\n`);
}

/**
 * Initialize oracle (deploy module if needed)
 */
async function initialize() {
  console.log(`\n🔧 Initializing Oracle Module...`);
  
  try {
    const transaction = await aptos.transaction.build.simple({
      sender: oracleAccount.accountAddress,
      data: {
        function: `${MODULE_ADDRESS}::solar_oracle::initialize`,
        functionArguments: [],
      },
    });

    const committedTxn = await aptos.signAndSubmitTransaction({
      signer: oracleAccount,
      transaction,
    });

    await aptos.waitForTransaction({ transactionHash: committedTxn.hash });
    
    console.log(`✅ Oracle initialized: ${committedTxn.hash}`);
  } catch (error: any) {
    if (error.message?.includes("RESOURCE_ALREADY_EXISTS")) {
      console.log(`ℹ️  Oracle already initialized`);
    } else {
      throw error;
    }
  }
}

// US Locations only - NREL API only supports US locations!
// See: https://developer.nrel.gov/docs/solar/solar-resource-v1/
const LOCATIONS = [
  { lat: 37.7749, lon: -122.4194 }, // San Francisco, CA
  { lat: 40.7128, lon: -74.0060 },  // New York City, NY
  { lat: 33.4484, lon: -112.0740 }, // Phoenix, AZ
];

// Run oracle
(async () => {
  try {
    // Initialize module (run once)
    // await initialize();
    
    // Update solar data
    await updateOracle(LOCATIONS);
    
    // Read back data (verification)
    await readFromChain(LOCATIONS[0].lat, LOCATIONS[0].lon);
    
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
})();

// For production: run this on a schedule (cron job / setInterval)
// setInterval(() => updateOracle(LOCATIONS), 24 * 60 * 60 * 1000); // Daily
