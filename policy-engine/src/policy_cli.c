#include "config.h"
#include "lead.h"
#include "lead_router.h"
#include "lead_rules.h"
#include "cJSON.h"

#include <ctype.h>
#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define POLICY_VERSION "clientops-triage-v1"
#define INPUT_LIMIT (32U * 1024U)

static void emit_error(const char *code, const char *message) {
    cJSON *root = cJSON_CreateObject();
    cJSON *error = cJSON_CreateObject();
    char *encoded = NULL;

    if ((root == NULL) || (error == NULL)) {
        cJSON_Delete(root);
        cJSON_Delete(error);
        (void)fputs("{\"ok\":false,\"error\":{\"code\":\"internal_error\",\"message\":\"Out of memory\"}}\n", stdout);
        return;
    }
    cJSON_AddBoolToObject(root, "ok", false);
    cJSON_AddStringToObject(error, "code", code != NULL ? code : "invalid_request");
    cJSON_AddStringToObject(error, "message", message != NULL ? message : "Invalid request");
    cJSON_AddItemToObject(root, "error", error);
    encoded = cJSON_PrintUnformatted(root);
    if (encoded != NULL) {
        (void)fputs(encoded, stdout);
        (void)fputc('\n', stdout);
        free(encoded);
    }
    cJSON_Delete(root);
}

static char *read_stdin_bounded(void) {
    char *buffer = (char *)malloc(INPUT_LIMIT + 1U);
    size_t used = 0U;

    if (buffer == NULL) {
        return NULL;
    }
    while (!feof(stdin)) {
        size_t available = INPUT_LIMIT - used;
        size_t count = 0U;
        if (available == 0U) {
            int extra = fgetc(stdin);
            if (extra != EOF) {
                free(buffer);
                return NULL;
            }
            break;
        }
        count = fread(buffer + used, 1U, available, stdin);
        used += count;
        if (ferror(stdin)) {
            free(buffer);
            return NULL;
        }
    }
    buffer[used] = '\0';
    return buffer;
}

static bool has_control_or_newline(const char *value) {
    const unsigned char *cursor = (const unsigned char *)value;
    if (value == NULL) {
        return true;
    }
    while (*cursor != '\0') {
        if ((*cursor < 0x20U) || (*cursor == 0x7FU)) {
            return true;
        }
        ++cursor;
    }
    return false;
}

static bool email_is_valid(const char *email) {
    const char *at = NULL;
    const char *dot = NULL;
    size_t length = 0U;
    if ((email == NULL) || has_control_or_newline(email)) {
        return false;
    }
    length = strlen(email);
    if ((length < 3U) || (length > 254U) || (email[0] == '@') ||
        (email[length - 1U] == '@') || (email[length - 1U] == '.')) {
        return false;
    }
    at = strchr(email, '@');
    if ((at == NULL) || (strchr(at + 1, '@') != NULL)) {
        return false;
    }
    dot = strchr(at + 1, '.');
    return (dot != NULL) && (dot > at + 1) && (dot[1] != '\0');
}

static bool key_is_allowed(const char *key) {
    static const char *const allowed[] = {
        "leadId", "channel", "name", "city", "phone", "email", "source", "message", "consent"
    };
    size_t i = 0U;
    for (i = 0U; i < sizeof(allowed) / sizeof(allowed[0]); ++i) {
        if (strcmp(key, allowed[i]) == 0) {
            return true;
        }
    }
    return false;
}

static bool copy_json_string(cJSON *root, const char *key, char *destination,
                             size_t destination_size, bool required,
                             char *error, size_t error_size) {
    cJSON *item = cJSON_GetObjectItemCaseSensitive(root, key);
    if (item == NULL) {
        if (required) {
            (void)snprintf(error, error_size, "%s is required", key);
            return false;
        }
        destination[0] = '\0';
        return true;
    }
    if (!cJSON_IsString(item) || (item->valuestring == NULL)) {
        (void)snprintf(error, error_size, "%s must be a string", key);
        return false;
    }
    if (!lead_copy_string(destination, destination_size, item->valuestring)) {
        (void)snprintf(error, error_size, "%s exceeds its maximum length", key);
        return false;
    }
    return true;
}

static bool parse_lead(cJSON *root, Lead *lead, char *error, size_t error_size) {
    cJSON *cursor = NULL;
    cJSON *consent = NULL;

    if (!cJSON_IsObject(root)) {
        (void)lead_copy_string(error, error_size, "request must be a JSON object");
        return false;
    }
    for (cursor = root->child; cursor != NULL; cursor = cursor->next) {
        if ((cursor->string == NULL) || !key_is_allowed(cursor->string)) {
            (void)snprintf(error, error_size, "unknown field: %s",
                           cursor->string != NULL ? cursor->string : "<unnamed>");
            return false;
        }
    }

    lead_init(lead);
    if (!copy_json_string(root, "leadId", lead->lead_id, sizeof(lead->lead_id), false, error, error_size) ||
        !copy_json_string(root, "channel", lead->channel, sizeof(lead->channel), false, error, error_size) ||
        !copy_json_string(root, "name", lead->customer_name, sizeof(lead->customer_name), true, error, error_size) ||
        !copy_json_string(root, "city", lead->city, sizeof(lead->city), false, error, error_size) ||
        !copy_json_string(root, "phone", lead->phone, sizeof(lead->phone), false, error, error_size) ||
        !copy_json_string(root, "email", lead->email, sizeof(lead->email), true, error, error_size) ||
        !copy_json_string(root, "source", lead->source, sizeof(lead->source), false, error, error_size) ||
        !copy_json_string(root, "message", lead->message, sizeof(lead->message), true, error, error_size)) {
        return false;
    }

    consent = cJSON_GetObjectItemCaseSensitive(root, "consent");
    if ((consent == NULL) || !cJSON_IsBool(consent) || !cJSON_IsTrue(consent)) {
        (void)lead_copy_string(error, error_size, "consent must be true");
        return false;
    }
    lead_normalize(lead);
    if ((lead->customer_name[0] == '\0') || (lead->message[0] == '\0')) {
        (void)lead_copy_string(error, error_size, "name and message cannot be empty");
        return false;
    }
    if (!email_is_valid(lead->email)) {
        (void)lead_copy_string(error, error_size, "email is invalid");
        return false;
    }
    if (has_control_or_newline(lead->customer_name) || has_control_or_newline(lead->city) ||
        has_control_or_newline(lead->source)) {
        (void)lead_copy_string(error, error_size, "header-like fields cannot contain control characters");
        return false;
    }
    return true;
}

static void complete_result(const Lead *lead, LeadResult *result, LeadRoute *route) {
    char summary[LEAD_SUMMARY_MAX];

    if ((lead == NULL) || (result == NULL) || (route == NULL)) {
        return;
    }

    switch (*route) {
        case ROUTE_SPAM:
            result->fit = false;
            (void)lead_copy_string(result->fit_reason, sizeof(result->fit_reason),
                                   "The message matches a configured spam rule.");
            (void)lead_copy_string(result->next_step, sizeof(result->next_step),
                                   "Suppress automated follow-up");
            (void)lead_copy_string(result->summary, sizeof(result->summary),
                                   "Automated promotional message suppressed.");
            result->draft_reply[0] = '\0';
            break;
        case ROUTE_INSUFFICIENT_INFORMATION:
            result->fit = false;
            (void)lead_copy_string(result->fit_reason, sizeof(result->fit_reason),
                                   "The message does not contain enough detail for deterministic routing.");
            (void)lead_copy_string(result->next_step, sizeof(result->next_step),
                                   "Ask for the requested outcome and preferred timing");
            (void)lead_copy_string(result->summary, sizeof(result->summary),
                                   "Request needs more detail before it can be routed.");
            (void)lead_copy_string(result->draft_reply, sizeof(result->draft_reply),
                                   "Thanks for contacting us. Please reply with a little more detail about what you need and your preferred timing.");
            break;
        case ROUTE_UNSUPPORTED:
            result->fit = false;
            (void)lead_copy_string(result->fit_reason, sizeof(result->fit_reason),
                                   "The message matches an operator-defined exclusion or no fallback category is configured.");
            (void)lead_copy_string(result->next_step, sizeof(result->next_step),
                                   "Route to the unsupported-request queue");
            (void)lead_copy_string(result->summary, sizeof(result->summary),
                                   "Request is outside the configured intake scope.");
            (void)lead_copy_string(result->draft_reply, sizeof(result->draft_reply),
                                   "Thanks for contacting us. This request is outside the scope handled by this intake channel.");
            break;
        case ROUTE_LOCATION_REVIEW:
            (void)lead_copy_string(result->fit_reason, sizeof(result->fit_reason),
                                   "The request is valid but its location is not on the configured allowlist.");
            (void)lead_copy_string(result->next_step, sizeof(result->next_step),
                                   "Review location coverage manually");
            (void)lead_copy_string(result->summary, sizeof(result->summary),
                                   "Request requires a location-coverage review.");
            (void)lead_copy_string(result->draft_reply, sizeof(result->draft_reply),
                                   "Thanks for contacting us. A team member will confirm whether we can assist in your location.");
            break;
        case ROUTE_URGENT:
            (void)lead_copy_string(result->fit_reason, sizeof(result->fit_reason),
                                   "The request is serviceable and matches a configured high-priority signal.");
            (void)lead_copy_string(result->next_step, sizeof(result->next_step),
                                   "Respond within 15 minutes");
            (void)lead_copy_string(result->draft_reply, sizeof(result->draft_reply),
                                   "Thanks for contacting us. Your request has been marked as urgent, and a team member will follow up as soon as possible.");
            break;
        case ROUTE_SPECIALIST:
            (void)lead_copy_string(result->fit_reason, sizeof(result->fit_reason),
                                   "The request matches a category configured for specialist handling.");
            (void)lead_copy_string(result->next_step, sizeof(result->next_step),
                                   "Assign a specialist within 2 hours");
            (void)lead_copy_string(result->draft_reply, sizeof(result->draft_reply),
                                   "Thanks for contacting us. We received your request and will route it to the appropriate specialist.");
            break;
        case ROUTE_STANDARD:
            (void)lead_copy_string(result->fit_reason, sizeof(result->fit_reason),
                                   "The request contains enough information for standard deterministic routing.");
            (void)lead_copy_string(result->next_step, sizeof(result->next_step),
                                   "Review and respond within 2 hours");
            (void)lead_copy_string(result->draft_reply, sizeof(result->draft_reply),
                                   "Thanks for contacting us. We received your request and will follow up shortly.");
            break;
        case ROUTE_MANUAL_REVIEW:
        default:
            (void)lead_copy_string(result->fit_reason, sizeof(result->fit_reason),
                                   "Multiple categories matched or the request could not be assigned safely.");
            (void)lead_copy_string(result->next_step, sizeof(result->next_step),
                                   "Review and assign an owner");
            (void)lead_copy_string(result->summary, sizeof(result->summary),
                                   "Request requires manual routing review.");
            (void)lead_copy_string(result->draft_reply, sizeof(result->draft_reply),
                                   "Thanks for contacting us. We received your request and will review it before replying.");
            break;
    }

    if (((*route == ROUTE_URGENT) || (*route == ROUTE_SPECIALIST) ||
         (*route == ROUTE_STANDARD)) && (result->summary[0] == '\0')) {
        (void)snprintf(summary, sizeof(summary),
                       "%s inquiry; urgency %s; score %u/100.",
                       result->category, result->urgency, result->score);
        (void)lead_copy_string(result->summary, sizeof(result->summary), summary);
    }
}

static cJSON *build_output(const Lead *lead, const LeadResult *result, LeadRoute route) {
    cJSON *root = cJSON_CreateObject();
    cJSON *normalized = cJSON_CreateObject();
    cJSON *decision = cJSON_CreateObject();
    if ((root == NULL) || (normalized == NULL) || (decision == NULL)) {
        cJSON_Delete(root);
        cJSON_Delete(normalized);
        cJSON_Delete(decision);
        return NULL;
    }

    cJSON_AddBoolToObject(root, "ok", true);
    cJSON_AddStringToObject(root, "policyVersion", POLICY_VERSION);
    cJSON_AddStringToObject(normalized, "leadId", lead->lead_id);
    cJSON_AddStringToObject(normalized, "channel", lead->channel);
    cJSON_AddStringToObject(normalized, "name", lead->customer_name);
    cJSON_AddStringToObject(normalized, "city", lead->city);
    cJSON_AddStringToObject(normalized, "phone", lead->phone);
    cJSON_AddStringToObject(normalized, "email", lead->email);
    cJSON_AddStringToObject(normalized, "source", lead->source);
    cJSON_AddStringToObject(normalized, "message", lead->message);
    cJSON_AddBoolToObject(normalized, "consent", true);
    cJSON_AddItemToObject(root, "lead", normalized);

    cJSON_AddBoolToObject(decision, "fit", result->fit);
    cJSON_AddStringToObject(decision, "fitReason", result->fit_reason);
    cJSON_AddStringToObject(decision, "category", result->category);
    cJSON_AddNumberToObject(decision, "score", result->score);
    cJSON_AddBoolToObject(decision, "serviceable", result->serviceable);
    cJSON_AddStringToObject(decision, "urgency", result->urgency);
    cJSON_AddStringToObject(decision, "summary", result->summary);
    cJSON_AddStringToObject(decision, "nextStep", result->next_step);
    cJSON_AddStringToObject(decision, "draftReply", result->draft_reply);
    cJSON_AddStringToObject(decision, "route", lead_route_name(route));
    cJSON_AddItemToObject(root, "decision", decision);
    return root;
}

int main(int argc, char **argv) {
    const char *config_path = "config/policy.json";
    char config_error[LEAD_ERROR_MAX] = {0};
    char parse_error[LEAD_ERROR_MAX] = {0};
    char *input = NULL;
    const char *end = NULL;
    cJSON *root = NULL;
    cJSON *output = NULL;
    char *encoded = NULL;
    LeadConfig config;
    Lead lead;
    LeadResult result;
    LeadRoute route;

    if ((argc == 2) && (strcmp(argv[1], "--version") == 0)) {
        (void)puts(POLICY_VERSION);
        return 0;
    }
    if ((argc == 3) && (strcmp(argv[1], "--config") == 0)) {
        config_path = argv[2];
    } else if (argc != 1) {
        emit_error("usage_error", "usage: policy_cli [--config PATH]");
        return 64;
    }
    if (!lead_config_load_json(config_path, &config, config_error, sizeof(config_error))) {
        emit_error("config_error", config_error);
        return 78;
    }

    input = read_stdin_bounded();
    if (input == NULL) {
        emit_error("payload_too_large", "request exceeds the 32 KiB input limit or could not be read");
        return 2;
    }
    root = cJSON_ParseWithOpts(input, &end, true);
    free(input);
    if ((root == NULL) || !cJSON_IsObject(root)) {
        emit_error("invalid_json", "request must be exactly one valid JSON object");
        cJSON_Delete(root);
        return 2;
    }
    if (!parse_lead(root, &lead, parse_error, sizeof(parse_error))) {
        emit_error("validation_error", parse_error);
        cJSON_Delete(root);
        return 2;
    }
    cJSON_Delete(root);

    lead_result_init(&result);
    lead_rules_apply(&lead, &config, &result);
    route = lead_route_final(&lead, &config, &result);
    complete_result(&lead, &result, &route);
    output = build_output(&lead, &result, route);
    if (output == NULL) {
        emit_error("internal_error", "could not allocate response");
        return 70;
    }
    encoded = cJSON_PrintUnformatted(output);
    cJSON_Delete(output);
    if (encoded == NULL) {
        emit_error("internal_error", "could not encode response");
        return 70;
    }
    (void)fputs(encoded, stdout);
    (void)fputc('\n', stdout);
    free(encoded);
    return 0;
}
