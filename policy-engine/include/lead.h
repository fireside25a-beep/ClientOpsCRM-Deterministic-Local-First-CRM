#ifndef LEAD_PROCESSOR_LEAD_H
#define LEAD_PROCESSOR_LEAD_H

#include <stdbool.h>
#include <stddef.h>

#define LEAD_ID_MAX 32U
#define LEAD_CHANNEL_MAX 32U
#define LEAD_NAME_MAX 160U
#define LEAD_CITY_MAX 128U
#define LEAD_PHONE_MAX 64U
#define LEAD_EMAIL_MAX 256U
#define LEAD_SOURCE_MAX 96U
#define LEAD_MESSAGE_MAX 8192U
#define LEAD_REASON_MAX 1024U
#define LEAD_CATEGORY_MAX 64U
#define LEAD_URGENCY_MAX 16U
#define LEAD_SUMMARY_MAX 1024U
#define LEAD_NEXT_STEP_MAX 512U
#define LEAD_DRAFT_REPLY_MAX 4096U
#define LEAD_ROUTE_MAX 64U
#define LEAD_ERROR_MAX 512U

typedef struct {
    char lead_id[LEAD_ID_MAX];
    char channel[LEAD_CHANNEL_MAX];
    char customer_name[LEAD_NAME_MAX];
    char city[LEAD_CITY_MAX];
    char phone[LEAD_PHONE_MAX];
    char email[LEAD_EMAIL_MAX];
    char source[LEAD_SOURCE_MAX];
    char message[LEAD_MESSAGE_MAX];
} Lead;

typedef struct {
    bool fit;
    char fit_reason[LEAD_REASON_MAX];
    char category[LEAD_CATEGORY_MAX];
    unsigned int score;
    bool serviceable;
    bool category_ambiguous;
    bool specialist;
    char urgency[LEAD_URGENCY_MAX];
    char summary[LEAD_SUMMARY_MAX];
    char next_step[LEAD_NEXT_STEP_MAX];
    char draft_reply[LEAD_DRAFT_REPLY_MAX];
} LeadResult;

typedef struct {
    Lead *items;
    size_t count;
    size_t capacity;
} LeadArray;

void lead_init(Lead *lead);
void lead_result_init(LeadResult *result);
void lead_array_init(LeadArray *array);
void lead_array_free(LeadArray *array);
bool lead_array_push(LeadArray *array, const Lead *lead);
void lead_normalize(Lead *lead);
bool lead_copy_string(char *dst, size_t dst_size, const char *src);

#endif
