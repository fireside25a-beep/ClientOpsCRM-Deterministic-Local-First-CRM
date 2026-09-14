CC ?= cc
CPPFLAGS ?= -D_POSIX_C_SOURCE=200809L -DCJSON_NESTING_LIMIT=64 -Iinclude -Ithird_party
WARNINGS := -Wall -Wextra -Wpedantic -Werror
CFLAGS ?= -std=c11 -O2 $(WARNINGS)
LDFLAGS ?=
LDLIBS ?= -lm

BUILD_DIR := build
RELEASE_TARGET := $(BUILD_DIR)/policy_cli
DEBUG_TARGET := $(BUILD_DIR)/debug/policy_cli
ASAN_TARGET := $(BUILD_DIR)/asan/policy_cli
UBSAN_TARGET := $(BUILD_DIR)/ubsan/policy_cli
SOURCES := src/policy_cli.c src/config.c src/lead.c src/lead_rules.c src/lead_router.c third_party/cJSON.c
HEADERS := include/config.h include/lead.h include/lead_router.h include/lead_rules.h third_party/cJSON.h

.PHONY: all release debug asan ubsan parity supply-chain test sanitize clean

all: release

release: $(RELEASE_TARGET)

debug: $(DEBUG_TARGET)

asan: $(ASAN_TARGET)

ubsan: $(UBSAN_TARGET)

$(RELEASE_TARGET): $(SOURCES) $(HEADERS)
	mkdir -p $(@D)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) $(SOURCES) $(LDLIBS) -o $@

$(DEBUG_TARGET): $(SOURCES) $(HEADERS)
	mkdir -p $(@D)
	$(CC) $(CPPFLAGS) -std=c11 -O0 -g3 $(WARNINGS) $(LDFLAGS) $(SOURCES) $(LDLIBS) -o $@

$(ASAN_TARGET): $(SOURCES) $(HEADERS)
	mkdir -p $(@D)
	$(CC) $(CPPFLAGS) -std=c11 -O1 -g3 $(WARNINGS) -fsanitize=address -fno-omit-frame-pointer \
		$(LDFLAGS) -fsanitize=address $(SOURCES) $(LDLIBS) -o $@

$(UBSAN_TARGET): $(SOURCES) $(HEADERS)
	mkdir -p $(@D)
	$(CC) $(CPPFLAGS) -std=c11 -O1 -g3 $(WARNINGS) -fsanitize=undefined -fno-omit-frame-pointer \
		$(LDFLAGS) -fsanitize=undefined $(SOURCES) $(LDLIBS) -o $@

supply-chain:
	node tests/test_supply_chain.mjs

parity: release debug asan ubsan
	node tests/test_build_parity.mjs $(RELEASE_TARGET) $(DEBUG_TARGET) $(ASAN_TARGET) $(UBSAN_TARGET) config/policy.json

test: release supply-chain
	node tests/test_policy.mjs $(RELEASE_TARGET) config/policy.json
	node tests/test_server.mjs $(RELEASE_TARGET) config/policy.json

sanitize: parity
	ASAN_OPTIONS=detect_leaks=0:halt_on_error=1 node tests/test_policy.mjs $(ASAN_TARGET) config/policy.json
	UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 node tests/test_policy.mjs $(UBSAN_TARGET) config/policy.json

clean:
	$(RM) -r $(BUILD_DIR)
