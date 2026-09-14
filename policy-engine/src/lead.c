#include "lead.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

void lead_init(Lead *lead) {
    if (lead != NULL) {
        memset(lead, 0, sizeof(*lead));
    }
}

void lead_result_init(LeadResult *result) {
    if (result != NULL) {
        memset(result, 0, sizeof(*result));
        (void)lead_copy_string(result->category, sizeof(result->category), "general");
        (void)lead_copy_string(result->urgency, sizeof(result->urgency), "medium");
    }
}

void lead_array_init(LeadArray *array) {
    if (array != NULL) {
        array->items = NULL;
        array->count = 0U;
        array->capacity = 0U;
    }
}

void lead_array_free(LeadArray *array) {
    if (array != NULL) {
        free(array->items);
        lead_array_init(array);
    }
}

bool lead_array_push(LeadArray *array, const Lead *lead) {
    Lead *grown = NULL;
    size_t new_capacity = 0U;

    if ((array == NULL) || (lead == NULL)) {
        return false;
    }
    if (array->count == array->capacity) {
        new_capacity = (array->capacity == 0U) ? 16U : array->capacity * 2U;
        if (new_capacity < array->capacity) {
            return false;
        }
        grown = (Lead *)realloc(array->items, new_capacity * sizeof(*grown));
        if (grown == NULL) {
            return false;
        }
        array->items = grown;
        array->capacity = new_capacity;
    }
    array->items[array->count++] = *lead;
    return true;
}

bool lead_copy_string(char *dst, size_t dst_size, const char *src) {
    size_t length = 0U;

    if ((dst == NULL) || (dst_size == 0U)) {
        return false;
    }
    if (src == NULL) {
        dst[0] = '\0';
        return true;
    }
    length = strlen(src);
    if (length >= dst_size) {
        memcpy(dst, src, dst_size - 1U);
        dst[dst_size - 1U] = '\0';
        return false;
    }
    memcpy(dst, src, length + 1U);
    return true;
}

static void trim_ascii(char *text) {
    char *start = text;
    size_t length = 0U;

    if (text == NULL) {
        return;
    }
    while ((*start != '\0') && isspace((unsigned char)*start)) {
        ++start;
    }
    if (start != text) {
        memmove(text, start, strlen(start) + 1U);
    }
    length = strlen(text);
    while ((length > 0U) && isspace((unsigned char)text[length - 1U])) {
        text[--length] = '\0';
    }
}

static void lowercase_ascii(char *text) {
    size_t i = 0U;
    if (text == NULL) {
        return;
    }
    for (i = 0U; text[i] != '\0'; ++i) {
        if ((unsigned char)text[i] < 128U) {
            text[i] = (char)tolower((unsigned char)text[i]);
        }
    }
}

static void normalize_phone(char *phone, size_t size) {
    char digits[LEAD_PHONE_MAX];
    size_t i = 0U;
    size_t used = 0U;
    bool international = false;

    if ((phone == NULL) || (size == 0U)) {
        return;
    }
    for (i = 0U; phone[i] != '\0'; ++i) {
        if (isspace((unsigned char)phone[i])) {
            continue;
        }
        international = phone[i] == '+';
        break;
    }
    for (i = 0U; (phone[i] != '\0') && (used + 1U < sizeof(digits)); ++i) {
        if (isdigit((unsigned char)phone[i])) {
            digits[used++] = phone[i];
        }
    }
    digits[used] = '\0';
    if (used == 0U) {
        phone[0] = '\0';
    } else if (international && (used + 2U <= size)) {
        phone[0] = '+';
        memcpy(phone + 1, digits, used + 1U);
    } else if (used + 1U <= size) {
        memcpy(phone, digits, used + 1U);
    } else {
        phone[0] = '\0';
    }
}

void lead_normalize(Lead *lead) {
    if (lead == NULL) {
        return;
    }
    trim_ascii(lead->lead_id);
    trim_ascii(lead->channel);
    trim_ascii(lead->customer_name);
    trim_ascii(lead->city);
    trim_ascii(lead->phone);
    trim_ascii(lead->email);
    trim_ascii(lead->source);
    trim_ascii(lead->message);
    lowercase_ascii(lead->channel);
    lowercase_ascii(lead->email);
    normalize_phone(lead->phone, sizeof(lead->phone));
}
