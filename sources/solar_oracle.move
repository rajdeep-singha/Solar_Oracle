// Storing off-chain NREL solar data on-chain

module solar_oracle::solar_oracle {
    use std::signer;
    use aptos_std::table::{Self, Table};
    use aptos_framework::timestamp;
    use aptos_framework::event;

    // Error codes
    const E_NOT_AUTHORIZED: u64 = 1;
    const E_ALREADY_INITIALIZED: u64 = 2;
    const E_NOT_INITIALIZED: u64 = 3;
    const E_LOCATION_NOT_FOUND: u64 = 4;
    const E_STALE_DATA: u64 = 5;

    // Location key (latitude and longitude in microdegrees)
    struct LocationKey has store, copy, drop {
    latitude: u64,   // microdegrees
    longitude: u64,
}


    // Solar data for a specific location
    struct SolarData has store, copy, drop {
        dni: u64,           // Direct Normal Irradiance * 100 (kWh/m²/day)
        ghi: u64,           // Global Horizontal Irradiance * 100
        lat_tilt: u64,      // Latitude Tilt * 100
        last_updated: u64,  // Unix timestamp (seconds)
    }

    // Global registry of solar data
    struct SolarRegistry has key {
        oracle_address: address,
        data: Table<LocationKey, SolarData>,
        total_locations: u64,
        update_count: u64,
    }

    
    #[event]
    struct DataUpdatedEvent has store, drop {
        latitude: u64,
        longitude: u64,
        dni: u64,
        ghi: u64,
        timestamp: u64,
    }

    #[event]
    struct OracleInitializedEvent has store, drop {
        oracle_address: address,
    }

    // Initialize the oracle (called once by deployer)
    public entry fun initialize(account: &signer) {
        let addr = signer::address_of(account);
        
        assert!(!exists<SolarRegistry>(addr), E_ALREADY_INITIALIZED);

        move_to(account, SolarRegistry {
            oracle_address: addr,
            data: table::new(),
            total_locations: 0,
            update_count: 0,
        });

        event::emit(OracleInitializedEvent {
            oracle_address: addr,
        });
    }




    //  public entry fun update_oracle(admin: &signer,new_oracle: address){

    //  }







    // Update solar data (only callable by oracle)
    public entry fun update_solar_data(
        oracle: &signer,
        latitude: u64,
        longitude: u64,
        dni: u64,
        ghi: u64,
        lat_tilt: u64,
        timestamp: u64,
        
    ) acquires SolarRegistry {
        let oracle_addr = signer::address_of(oracle);
        
        assert!(exists<SolarRegistry>(oracle_addr), E_NOT_INITIALIZED);
        
        let registry = borrow_global_mut<SolarRegistry>(oracle_addr);
        
        assert!(oracle_addr == registry.oracle_address, E_NOT_AUTHORIZED);

        let location_key = LocationKey { latitude, longitude };

        let now = timestamp::now_seconds(); 

        assert!(timestamp <= now, E_STALE_DATA);

        
        let new_data = SolarData {
            dni,
            ghi,
            lat_tilt,
            last_updated: timestamp,
        };

        // Check if location exists
        if (table::contains(&registry.data, location_key)) {
            // Update existing location
            let old_data = table::borrow_mut(&mut registry.data, location_key);
            *old_data = new_data;
        } else {
            // Add new location
            table::add(&mut registry.data, location_key, new_data);
            registry.total_locations = registry.total_locations + 1;
        };

        registry.update_count = registry.update_count + 1;

        event::emit(DataUpdatedEvent {
            latitude,
            longitude,
            dni,
            ghi,
            timestamp,
        });
    }

    // Get solar data for a location (public read)
    #[view]
    public fun get_solar_data(
        oracle_addr: address,
        latitude: u64,
        longitude: u64,
    ): (u64, u64, u64, u64) acquires SolarRegistry {
        assert!(exists<SolarRegistry>(oracle_addr), E_NOT_INITIALIZED);
        
        let registry = borrow_global<SolarRegistry>(oracle_addr);
        let location_key = LocationKey { latitude, longitude };
        
        assert!(table::contains(&registry.data, location_key), E_LOCATION_NOT_FOUND);
        
        let data = table::borrow(&registry.data, location_key);
        
        (data.dni, data.ghi, data.lat_tilt, data.last_updated)
    }

    // Check if data exists for a location
    #[view]
    public fun has_data(
        oracle_addr: address,
        latitude: u64,
        longitude: u64,
    ): bool acquires SolarRegistry {
        if (!exists<SolarRegistry>(oracle_addr)) {
            return false
        };
        
        let registry = borrow_global<SolarRegistry>(oracle_addr);
        let location_key = LocationKey { latitude, longitude };
        
        table::contains(&registry.data, location_key)
    }

    // Get registry statistics
    #[view]
    public fun get_stats(oracle_addr: address): (u64, u64) acquires SolarRegistry {
        assert!(exists<SolarRegistry>(oracle_addr), E_NOT_INITIALIZED);
        
        let registry = borrow_global<SolarRegistry>(oracle_addr);
        (registry.total_locations, registry.update_count)
    }

    // Check if data is fresh (updated within last 7 days)
    #[view]
    public fun is_data_fresh(
        oracle_addr: address,
        latitude: u64,
        longitude: u64,
        max_age_seconds: u64,
    ): bool acquires SolarRegistry {
        if (!has_data(oracle_addr, latitude, longitude)) {
            return false
        };

        let (_, _, _, last_updated) = get_solar_data(oracle_addr, latitude, longitude);
        let current_time = timestamp::now_seconds();
        
        (current_time - last_updated) <= max_age_seconds
    }

    // Utility: Convert microdegrees back to readable format
    #[view]
    public fun microdegrees_to_degrees(microdegrees: u64): u64 {
        microdegrees / 1000000
    }

    // Utility: Convert stored value back to decimal (divide by 100)
    #[view]
    public fun to_decimal(value: u64): u64 {
        value / 100
    }

    // Example consumer function: Check if location is suitable for solar
    #[view]
    public fun is_suitable_for_solar(
        oracle_addr: address,
        latitude: u64,
        longitude: u64,
        min_dni_threshold: u64, // Minimum DNI * 100
    ): bool acquires SolarRegistry {
        if (!has_data(oracle_addr, latitude, longitude)) {
            return false
        };

        let (dni, _, _, _) = get_solar_data(oracle_addr, latitude, longitude);
        
        dni >= min_dni_threshold
    }

    #[test_only]
    use aptos_framework::account;

    #[test(oracle = @solar_oracle)]
    fun test_initialize_and_update(oracle: &signer) acquires SolarRegistry {
        let oracle_addr = signer::address_of(oracle);
        account::create_account_for_test(oracle_addr);

        // Initialize
        initialize(oracle);
        assert!(exists<SolarRegistry>(oracle_addr), 0);

        // Update data
        let lat = 12971600; // 12.9716 degrees
        let lon = 77594600; // 77.5946 degrees
        
        update_solar_data(oracle, lat, lon, 580, 520, 600, 1704067200);

        // Verify data
        let (dni, ghi, lat_tilt, timestamp) = get_solar_data(oracle_addr, lat, lon);
        assert!(dni == 580, 1);
        assert!(ghi == 520, 2);
        assert!(lat_tilt == 600, 3);
        assert!(timestamp == 1704067200, 4);

        // Check stats
        let (total, updates) = get_stats(oracle_addr);
        assert!(total == 1, 5);
        assert!(updates == 1, 6);
    }

    #[test(oracle = @solar_oracle)]
    fun test_multiple_locations(oracle: &signer) acquires SolarRegistry {
        let oracle_addr = signer::address_of(oracle);
        account::create_account_for_test(oracle_addr);

        initialize(oracle);

        // Add multiple locations
        update_solar_data(oracle, 12971600, 77594600, 580, 520, 600, 1704067200);
        update_solar_data(oracle, 37774900, -122419400, 620, 550, 630, 1704067200);

        let (total, updates) = get_stats(oracle_addr);
        assert!(total == 2, 0);
        assert!(updates == 2, 1);
    }

    #[test(oracle = @solar_oracle)]
    fun test_suitable_for_solar(oracle: &signer) acquires SolarRegistry {
        let oracle_addr = signer::address_of(oracle);
        account::create_account_for_test(oracle_addr);

        initialize(oracle);
        
        let lat = 12971600;
        let lon = 77594600;
        update_solar_data(oracle, lat, lon, 580, 520, 600, 1704067200);

        // Test with threshold
        assert!(is_suitable_for_solar(oracle_addr, lat, lon, 500), 0);
        assert!(!is_suitable_for_solar(oracle_addr, lat, lon, 600), 1);
    }
}
