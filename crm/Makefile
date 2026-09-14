CXX ?= c++
PKG_CONFIG ?= pkg-config
CPPFLAGS += $(shell $(PKG_CONFIG) --cflags sqlite3)
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=3
LDLIBS += $(shell $(PKG_CONFIG) --libs sqlite3)
BUILD_DIR := build
TARGET := $(BUILD_DIR)/clientops-crm
SOURCE := src/clientops_crm.cpp

.PHONY: all release debug sanitize test clean
all: release
release: $(TARGET)

$(TARGET): $(SOURCE)
	@mkdir -p $(BUILD_DIR)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) $(SOURCE) -o $(TARGET) $(LDFLAGS) $(LDLIBS)

debug:
	@mkdir -p $(BUILD_DIR)
	$(CXX) $(CPPFLAGS) -std=c++17 -O0 -g3 -Wall -Wextra -Wpedantic -Werror $(SOURCE) -o $(BUILD_DIR)/clientops-crm-debug $(LDFLAGS) $(LDLIBS)

sanitize:
	@mkdir -p $(BUILD_DIR)
	$(CXX) $(CPPFLAGS) -std=c++17 -O1 -g -Wall -Wextra -Wpedantic -Werror -fno-omit-frame-pointer -fsanitize=address,undefined $(SOURCE) -o $(BUILD_DIR)/clientops-crm-sanitize $(LDFLAGS) $(LDLIBS) -fsanitize=address,undefined

clean:
	rm -rf $(BUILD_DIR)
